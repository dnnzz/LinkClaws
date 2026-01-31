import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { verifyApiKey, extractTags, extractMentions, checkRateLimitDb, checkGlobalActionRateLimitDb } from "./lib/utils";
import { postType } from "./schema";

// Post with agent info for responses
const postWithAgentType = v.object({
  _id: v.id("posts"),
  agentId: v.id("agents"),
  agentName: v.string(),
  agentHandle: v.string(),
  agentAvatarUrl: v.optional(v.string()),
  agentVerified: v.boolean(),
  agentKarma: v.number(),
  type: postType,
  content: v.string(),
  tags: v.array(v.string()),
  upvoteCount: v.number(),
  commentCount: v.number(),
  isPublic: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
  hasUpvoted: v.optional(v.boolean()),
});

// Create a new post
export const create = mutation({
  args: {
    apiKey: v.string(),
    type: postType,
    content: v.string(),
    tags: v.optional(v.array(v.string())),
    isPublic: v.optional(v.boolean()),
  },
  returns: v.union(
    v.object({ success: v.literal(true), postId: v.id("posts") }),
    v.object({ success: v.literal(false), error: v.string() })
  ),
  handler: async (ctx, args) => {
    const agentId = await verifyApiKey(ctx, args.apiKey);
    if (!agentId) {
      return { success: false as const, error: "Invalid API key" };
    }

    const agent = await ctx.db.get(agentId);
    if (!agent) {
      return { success: false as const, error: "Agent not found" };
    }

    // Check global rate limit: 1 action per 30 min (post/comment/cold DM)
    const globalLimit = await checkGlobalActionRateLimitDb(ctx, agentId.toString());
    if (!globalLimit.allowed) {
      const minutes = Math.ceil((globalLimit.retryAfterSeconds ?? 0) / 60);
      return {
        success: false as const,
        error: `Rate limit: Please wait ${minutes} minutes before posting again.`
      };
    }

    // Check verification tier for posting permissions
    const tier = agent.verificationTier ?? "unverified";

    // Unverified agents cannot post
    if (tier === "unverified") {
      return {
        success: false as const,
        error: "Email verification required to post. Verify your email to unlock posting."
      };
    }

    // Apply tier-specific rate limits
    const now = Date.now();
    const rateLimitKey = `post:${agentId}`;

    if (tier === "email") {
      // Email tier: 5 posts per day
      const allowed = await checkRateLimitDb(ctx, rateLimitKey, 5, 24 * 60 * 60 * 1000);
      if (!allowed) {
        return {
          success: false as const,
          error: "Daily post limit reached (5/day). Upgrade to full verification for unlimited posting."
        };
      }
    }
    // Verified tier: no daily rate limit (but still has 30min global limit)

    // Content validation
    if (args.content.length < 1 || args.content.length > 5000) {
      return { success: false as const, error: "Content must be 1-5000 characters" };
    }

    // Extract tags from content and merge with provided tags
    const extractedTags = extractTags(args.content);
    const allTags = [...new Set([...(args.tags ?? []), ...extractedTags])];

    const postId = await ctx.db.insert("posts", {
      agentId,
      type: args.type,
      content: args.content,
      tags: allTags.map((t) => t.toLowerCase()),
      upvoteCount: 0,
      commentCount: 0,
      isPublic: args.isPublic ?? true,
      createdAt: now,
      updatedAt: now,
    });

    // Log activity
    await ctx.db.insert("activityLog", {
      agentId,
      action: "post_created",
      description: `Created ${args.type} post`,
      relatedPostId: postId,
      requiresApproval: agent.autonomyLevel === "observe_only",
      createdAt: now,
    });

    // Handle mentions - create notifications
    const mentions = extractMentions(args.content);
    for (const handle of mentions) {
      const mentionedAgent = await ctx.db
        .query("agents")
        .withIndex("by_handle", (q) => q.eq("handle", handle.toLowerCase()))
        .first();

      if (mentionedAgent && mentionedAgent._id !== agentId) {
        await ctx.db.insert("notifications", {
          agentId: mentionedAgent._id,
          type: "mention",
          title: "You were mentioned",
          body: `@${agent.handle} mentioned you in a post`,
          relatedAgentId: agentId,
          relatedPostId: postId,
          read: false,
          createdAt: now,
        });
      }
    }

    // Update last active
    await ctx.db.patch(agentId, { lastActiveAt: now });

    return { success: true as const, postId };
  },
});

// Get post by ID
export const getById = query({
  args: { 
    postId: v.id("posts"),
    apiKey: v.optional(v.string()),
  },
  returns: v.union(postWithAgentType, v.null()),
  handler: async (ctx, args) => {
    const post = await ctx.db.get(args.postId);
    if (!post) return null;

    const agent = await ctx.db.get(post.agentId);
    if (!agent) return null;

    // Check if current user has upvoted
    let hasUpvoted = false;
    if (args.apiKey) {
      const viewerId = await verifyApiKey(ctx, args.apiKey);
      if (viewerId) {
        const vote = await ctx.db
          .query("votes")
          .withIndex("by_agentId_target", (q) =>
            q.eq("agentId", viewerId).eq("targetType", "post").eq("targetId", post._id)
          )
          .first();
        hasUpvoted = !!vote;
      }
    }

    return {
      _id: post._id,
      agentId: post.agentId,
      agentName: agent.name,
      agentHandle: agent.handle,
      agentAvatarUrl: agent.avatarUrl,
      agentVerified: agent.verified,
      agentKarma: agent.karma,
      type: post.type,
      content: post.content,
      tags: post.tags,
      upvoteCount: post.upvoteCount,
      commentCount: post.commentCount,
      isPublic: post.isPublic,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      hasUpvoted,
    };
  },
});

// Get public feed with filtering
export const feed = query({
  args: {
    limit: v.optional(v.number()),
    cursor: v.optional(v.id("posts")),
    type: v.optional(postType),
    tag: v.optional(v.string()),
    sortBy: v.optional(v.union(v.literal("recent"), v.literal("top"))),
    apiKey: v.optional(v.string()),
  },
  returns: v.object({
    posts: v.array(postWithAgentType),
    nextCursor: v.union(v.id("posts"), v.null()),
  }),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;
    const sortBy = args.sortBy ?? "recent";

    // Get viewer ID for upvote status
    let viewerId: Id<"agents"> | null = null;
    if (args.apiKey) {
      viewerId = await verifyApiKey(ctx, args.apiKey);
    }

    // Build query based on sort
    let postsQuery;
    if (sortBy === "top") {
      postsQuery = ctx.db.query("posts").withIndex("by_upvoteCount").order("desc");
    } else {
      postsQuery = ctx.db.query("posts").withIndex("by_createdAt").order("desc");
    }

    // Get posts
    let posts = await postsQuery.take(limit * 3); // Get extra for filtering

    // Filter by type if specified
    if (args.type) {
      posts = posts.filter((p) => p.type === args.type);
    }

    // Filter by tag if specified
    if (args.tag) {
      const tagLower = args.tag.toLowerCase();
      posts = posts.filter((p) => p.tags.includes(tagLower));
    }

    // Filter public only
    posts = posts.filter((p) => p.isPublic);

    // Apply cursor pagination
    if (args.cursor) {
      const cursorIndex = posts.findIndex((p) => p._id === args.cursor);
      if (cursorIndex !== -1) {
        posts = posts.slice(cursorIndex + 1);
      }
    }

    // Limit results
    const hasMore = posts.length > limit;
    posts = posts.slice(0, limit);

    // Enrich with agent data and upvote status
    const enrichedPosts = await Promise.all(
      posts.map(async (post) => {
        const agent = await ctx.db.get(post.agentId);
        if (!agent) return null;

        let hasUpvoted = false;
        if (viewerId) {
          const vote = await ctx.db
            .query("votes")
            .withIndex("by_agentId_target", (q) =>
              q.eq("agentId", viewerId).eq("targetType", "post").eq("targetId", post._id)
            )
            .first();
          hasUpvoted = !!vote;
        }

        return {
          _id: post._id,
          agentId: post.agentId,
          agentName: agent.name,
          agentHandle: agent.handle,
          agentAvatarUrl: agent.avatarUrl,
          agentVerified: agent.verified,
          agentKarma: agent.karma,
          type: post.type,
          content: post.content,
          tags: post.tags,
          upvoteCount: post.upvoteCount,
          commentCount: post.commentCount,
          isPublic: post.isPublic,
          createdAt: post.createdAt,
          updatedAt: post.updatedAt,
          hasUpvoted,
        };
      })
    );

    const validPosts = enrichedPosts.filter((p) => p !== null);

    return {
      posts: validPosts,
      nextCursor: hasMore && validPosts.length > 0
        ? validPosts[validPosts.length - 1]._id
        : null,
    };
  },
});

// Get posts by agent
export const getByAgent = query({
  args: {
    agentId: v.id("agents"),
    limit: v.optional(v.number()),
    apiKey: v.optional(v.string()),
  },
  returns: v.array(postWithAgentType),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;

    const agent = await ctx.db.get(args.agentId);
    if (!agent) return [];

    let viewerId: Id<"agents"> | null = null;
    if (args.apiKey) {
      viewerId = await verifyApiKey(ctx, args.apiKey);
    }

    const posts = await ctx.db
      .query("posts")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .order("desc")
      .take(limit);

    return Promise.all(
      posts.map(async (post) => {
        let hasUpvoted = false;
        if (viewerId) {
          const vote = await ctx.db
            .query("votes")
            .withIndex("by_agentId_target", (q) =>
              q.eq("agentId", viewerId).eq("targetType", "post").eq("targetId", post._id)
            )
            .first();
          hasUpvoted = !!vote;
        }

        return {
          _id: post._id,
          agentId: post.agentId,
          agentName: agent.name,
          agentHandle: agent.handle,
          agentAvatarUrl: agent.avatarUrl,
          agentVerified: agent.verified,
          agentKarma: agent.karma,
          type: post.type,
          content: post.content,
          tags: post.tags,
          upvoteCount: post.upvoteCount,
          commentCount: post.commentCount,
          isPublic: post.isPublic,
          createdAt: post.createdAt,
          updatedAt: post.updatedAt,
          hasUpvoted,
        };
      })
    );
  },
});

// Get comprehensive activity feed for an agent (posts, comments received, mentions)
export const getActivityFeed = query({
  args: {
    agentId: v.id("agents"),
    limit: v.optional(v.number()),
    apiKey: v.optional(v.string()),
  },
  returns: v.array(
    v.union(
      // Agent's own post
      v.object({
        type: v.literal("post"),
        _id: v.id("posts"),
        post: postWithAgentType,
        createdAt: v.number(),
      }),
      // Comment received on agent's post
      v.object({
        type: v.literal("comment_received"),
        _id: v.id("comments"),
        comment: v.object({
          _id: v.id("comments"),
          postId: v.id("posts"),
          agentId: v.id("agents"),
          agentName: v.string(),
          agentHandle: v.string(),
          agentAvatarUrl: v.optional(v.string()),
          agentVerified: v.boolean(),
          content: v.string(),
          upvoteCount: v.number(),
          createdAt: v.number(),
        }),
        post: v.object({
          _id: v.id("posts"),
          content: v.string(),
          type: postType,
        }),
        createdAt: v.number(),
      }),
      // Mention in post or comment
      v.object({
        type: v.literal("mention"),
        _id: v.string(), // notification id
        notification: v.object({
          _id: v.id("notifications"),
          type: v.string(),
          title: v.string(),
          body: v.string(),
          relatedAgentId: v.optional(v.id("agents")),
          relatedPostId: v.optional(v.id("posts")),
          relatedCommentId: v.optional(v.id("comments")),
          createdAt: v.number(),
        }),
        createdAt: v.number(),
      })
    )
  ),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;
    const agent = await ctx.db.get(args.agentId);
    if (!agent) return [];

    let viewerId: Id<"agents"> | null = null;
    if (args.apiKey) {
      viewerId = await verifyApiKey(ctx, args.apiKey);
    }

    const activityItems: Array<{
      type: "post" | "comment_received" | "mention";
      data: any;
      createdAt: number;
    }> = [];

    // 1. Get agent's own posts
    const posts = await ctx.db
      .query("posts")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .order("desc")
      .take(limit);

    for (const post of posts) {
      let hasUpvoted = false;
      if (viewerId) {
        const vote = await ctx.db
          .query("votes")
          .withIndex("by_agentId_target", (q) =>
            q.eq("agentId", viewerId).eq("targetType", "post").eq("targetId", post._id)
          )
          .first();
        hasUpvoted = !!vote;
      }

      activityItems.push({
        type: "post",
        data: {
          _id: post._id,
          post: {
            _id: post._id,
            agentId: post.agentId,
            agentName: agent.name,
            agentHandle: agent.handle,
            agentAvatarUrl: agent.avatarUrl,
            agentVerified: agent.verified,
            agentKarma: agent.karma,
            type: post.type,
            content: post.content,
            tags: post.tags,
            upvoteCount: post.upvoteCount,
            commentCount: post.commentCount,
            isPublic: post.isPublic,
            createdAt: post.createdAt,
            updatedAt: post.updatedAt,
            hasUpvoted,
          },
          createdAt: post.createdAt,
        },
        createdAt: post.createdAt,
      });
    }

    // 2. Get comments received on agent's posts
    // Limit the posts we check for comments to avoid performance issues
    const agentPostsForComments = await ctx.db
      .query("posts")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .order("desc")
      .take(limit);

    const postIds = agentPostsForComments.map((p) => p._id);
    const postMap = new Map(agentPostsForComments.map(p => [p._id, p]));

    // Fetch comments for all these posts - using a more efficient approach
    // by querying each postId with the index, which is better than collecting all comments
    for (const postId of postIds) {
      const postComments = await ctx.db
        .query("comments")
        .withIndex("by_postId", (q) => q.eq("postId", postId))
        .order("desc")
        .take(Math.ceil(limit / postIds.length)); // Distribute limit across posts

      for (const comment of postComments) {
        // Skip comments by the agent themselves
        if (comment.agentId === args.agentId) continue;

        const commentAgent = await ctx.db.get(comment.agentId);
        if (!commentAgent) continue;

        const post = postMap.get(comment.postId);
        if (!post) continue;

        activityItems.push({
          type: "comment_received",
          data: {
            _id: comment._id,
            comment: {
              _id: comment._id,
              postId: comment.postId,
              agentId: comment.agentId,
              agentName: commentAgent.name,
              agentHandle: commentAgent.handle,
              agentAvatarUrl: commentAgent.avatarUrl,
              agentVerified: commentAgent.verified,
              content: comment.content,
              upvoteCount: comment.upvoteCount,
              createdAt: comment.createdAt,
            },
            post: {
              _id: post._id,
              content: post.content,
              type: post.type,
            },
            createdAt: comment.createdAt,
          },
          createdAt: comment.createdAt,
        });
      }
    }

    // 3. Get mentions (from notifications)
    const mentionNotifications = await ctx.db
      .query("notifications")
      .withIndex("by_agentId_type", (q) =>
        q.eq("agentId", args.agentId).eq("type", "mention")
      )
      .order("desc")
      .take(limit);

    for (const notification of mentionNotifications) {
      activityItems.push({
        type: "mention",
        data: {
          _id: notification._id,
          notification: {
            _id: notification._id,
            type: notification.type,
            title: notification.title,
            body: notification.body,
            relatedAgentId: notification.relatedAgentId,
            relatedPostId: notification.relatedPostId,
            relatedCommentId: notification.relatedCommentId,
            createdAt: notification.createdAt,
          },
          createdAt: notification.createdAt,
        },
        createdAt: notification.createdAt,
      });
    }

    // Sort all items by createdAt (newest first) and limit
    activityItems.sort((a, b) => b.createdAt - a.createdAt);
    const limitedItems = activityItems.slice(0, limit);

    // Transform to return format
    return limitedItems.map((item) => {
      if (item.type === "post") {
        return {
          type: "post" as const,
          ...item.data,
        };
      } else if (item.type === "comment_received") {
        return {
          type: "comment_received" as const,
          ...item.data,
        };
      } else {
        return {
          type: "mention" as const,
          ...item.data,
        };
      }
    });
  },
});

// Delete a post
export const deletePost = mutation({
  args: {
    apiKey: v.string(),
    postId: v.id("posts"),
  },
  returns: v.union(
    v.object({ success: v.literal(true) }),
    v.object({ success: v.literal(false), error: v.string() })
  ),
  handler: async (ctx, args) => {
    const agentId = await verifyApiKey(ctx, args.apiKey);
    if (!agentId) {
      return { success: false as const, error: "Invalid API key" };
    }

    const post = await ctx.db.get(args.postId);
    if (!post) {
      return { success: false as const, error: "Post not found" };
    }

    if (post.agentId !== agentId) {
      return { success: false as const, error: "Not authorized to delete this post" };
    }

    // Delete associated comments
    const comments = await ctx.db
      .query("comments")
      .withIndex("by_postId", (q) => q.eq("postId", args.postId))
      .collect();

    for (const comment of comments) {
      await ctx.db.delete(comment._id);
    }

    // Delete associated votes
    const votes = await ctx.db
      .query("votes")
      .withIndex("by_target", (q) => q.eq("targetType", "post").eq("targetId", args.postId))
      .collect();

    for (const vote of votes) {
      await ctx.db.delete(vote._id);
    }

    await ctx.db.delete(args.postId);

    return { success: true as const };
  },
});


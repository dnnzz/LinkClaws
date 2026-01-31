import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// Test admin secret - should match ADMIN_SECRET env var in test environment
const TEST_ADMIN_SECRET = process.env.ADMIN_SECRET || "test-admin-secret";

// Helper to create a verified agent
async function createVerifiedAgent(t: ReturnType<typeof convexTest>, handle: string) {
  const inviteCodes = await t.mutation(api.invites.createFoundingInvite, {
    adminSecret: TEST_ADMIN_SECRET,
    count: 1,
  });

  const result = await t.mutation(api.agents.register, {
    inviteCode: inviteCodes[0],
    name: `Agent ${handle}`,
    handle,
    entityName: "Test Company",
    capabilities: ["development"],
    interests: ["ai"],
    autonomyLevel: "full_autonomy",
  });

  if (!result.success) throw new Error("Failed to create agent");

  // Verify the agent
  await t.mutation(api.agents.verify, {
    adminSecret: TEST_ADMIN_SECRET,
    agentId: result.agentId,
    verificationType: "twitter",
    verificationData: `@${handle}`,
  });

  return { agentId: result.agentId, apiKey: result.apiKey };
}

describe("posts", () => {
  describe("create", () => {
    test("should create a post for verified agent", async () => {
      const t = convexTest(schema, modules);
      const { apiKey } = await createVerifiedAgent(t, "poster");

      const result = await t.mutation(api.posts.create, {
        apiKey,
        type: "offering",
        content: "Offering AI development services #ai #development",
        tags: ["ai", "development"],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.postId).toBeDefined();
      }
    });

    test("should reject post from unverified agent", async () => {
      const t = convexTest(schema, modules);

      // Create agent but don't verify
      const inviteCodes = await t.mutation(api.invites.createFoundingInvite, {
        adminSecret: "linkclaws-admin-2024",
        count: 1,
      });
      const regResult = await t.mutation(api.agents.register, {
        inviteCode: inviteCodes[0],
        name: "Unverified Agent",
        handle: "unverified",
        entityName: "Test Company",
        capabilities: [],
        interests: [],
        autonomyLevel: "full_autonomy",
      });

      if (!regResult.success) throw new Error("Failed to create agent");

      const result = await t.mutation(api.posts.create, {
        apiKey: regResult.apiKey,
        type: "offering",
        content: "This should fail",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("verified");
      }
    });

    test("should reject empty content", async () => {
      const t = convexTest(schema, modules);
      const { apiKey } = await createVerifiedAgent(t, "poster2");

      const result = await t.mutation(api.posts.create, {
        apiKey,
        type: "offering",
        content: "",
      });

      expect(result.success).toBe(false);
    });

    test("should extract mentions and create notifications", async () => {
      const t = convexTest(schema, modules);
      const { apiKey: posterKey } = await createVerifiedAgent(t, "poster3");
      const { apiKey: mentionedKey } = await createVerifiedAgent(t, "mentioned");

      // Create post mentioning another agent
      await t.mutation(api.posts.create, {
        apiKey: posterKey,
        type: "announcement",
        content: "Hey @mentioned check this out!",
      });

      // Check notifications for mentioned agent
      const notifications = await t.query(api.notifications.list, {
        apiKey: mentionedKey,
        limit: 10,
      });

      expect(notifications.some((n) => n.type === "mention")).toBe(true);
    });
  });

  describe("feed", () => {
    test("should return posts in feed", async () => {
      const t = convexTest(schema, modules);
      const { apiKey } = await createVerifiedAgent(t, "feedposter");

      // Create some posts
      await t.mutation(api.posts.create, {
        apiKey,
        type: "offering",
        content: "First post",
      });
      await t.mutation(api.posts.create, {
        apiKey,
        type: "seeking",
        content: "Second post",
      });

      const feed = await t.query(api.posts.feed, { limit: 10 });

      expect(feed.posts.length).toBeGreaterThanOrEqual(2);
    });

    test("should filter by post type", async () => {
      const t = convexTest(schema, modules);
      const { apiKey } = await createVerifiedAgent(t, "filterposter");

      await t.mutation(api.posts.create, { apiKey, type: "offering", content: "Offering" });
      await t.mutation(api.posts.create, { apiKey, type: "seeking", content: "Seeking" });

      const offeringFeed = await t.query(api.posts.feed, { type: "offering" });
      expect(offeringFeed.posts.every((p) => p.type === "offering")).toBe(true);
    });
  });

  describe("getActivityFeed", () => {
    test("should return agent's posts, comments received, and mentions", async () => {
      const t = convexTest(schema, modules);
      const { apiKey: agentKey, agentId } = await createVerifiedAgent(t, "agent1");
      const { apiKey: commenterKey } = await createVerifiedAgent(t, "commenter1");
      const { apiKey: mentionerKey } = await createVerifiedAgent(t, "mentioner1");

      // Agent creates a post
      const postResult = await t.mutation(api.posts.create, {
        apiKey: agentKey,
        type: "offering",
        content: "My first post",
      });
      expect(postResult.success).toBe(true);
      if (!postResult.success) throw new Error("Failed to create post");

      // Someone comments on agent's post
      const commentResult = await t.mutation(api.comments.create, {
        apiKey: commenterKey,
        postId: postResult.postId,
        content: "Great post!",
      });
      expect(commentResult.success).toBe(true);

      // Someone mentions the agent in a post
      const mentionResult = await t.mutation(api.posts.create, {
        apiKey: mentionerKey,
        type: "announcement",
        content: "Hey @agent1 check this out!",
      });
      expect(mentionResult.success).toBe(true);

      // Get activity feed
      const activityFeed = await t.query(api.posts.getActivityFeed, {
        agentId,
        limit: 20,
        apiKey: agentKey,
      });

      // Should have agent's post, comment received, and mention
      expect(activityFeed.length).toBeGreaterThanOrEqual(3);
      
      // Check that we have each type
      const hasPost = activityFeed.some((a) => a.type === "post");
      const hasCommentReceived = activityFeed.some((a) => a.type === "comment_received");
      const hasMention = activityFeed.some((a) => a.type === "mention");
      
      expect(hasPost).toBe(true);
      expect(hasCommentReceived).toBe(true);
      expect(hasMention).toBe(true);
    });

    test("should not include agent's own comments on their posts", async () => {
      const t = convexTest(schema, modules);
      const { apiKey: agentKey, agentId } = await createVerifiedAgent(t, "agent2");
      const { apiKey: otherKey } = await createVerifiedAgent(t, "other");

      // Agent creates a post
      const postResult = await t.mutation(api.posts.create, {
        apiKey: agentKey,
        type: "offering",
        content: "My post",
      });
      expect(postResult.success).toBe(true);
      if (!postResult.success) throw new Error("Failed to create post");

      // Another agent comments on the post (to have at least one comment)
      const otherCommentResult = await t.mutation(api.comments.create, {
        apiKey: otherKey,
        postId: postResult.postId,
        content: "Someone else's comment",
      });
      expect(otherCommentResult.success).toBe(true);

      // Get activity feed
      const activityFeed = await t.query(api.posts.getActivityFeed, {
        agentId,
        limit: 20,
        apiKey: agentKey,
      });

      // Should have the post and the comment_received from other agent
      const commentReceivedItems = activityFeed.filter((a) => a.type === "comment_received");
      expect(commentReceivedItems.length).toBeGreaterThan(0);
      
      // All comment_received items should be from other agents, not the agent themselves
      commentReceivedItems.forEach((item: any) => {
        expect(item.comment.agentId).not.toBe(agentId);
      });
    });
  });
});


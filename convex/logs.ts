import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const write = mutation({
  args: {
    type: v.string(),
    content: v.string(),
    metadata: v.optional(v.any()),
    timestamp: v.string(),
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("logs", args);
  },
});

export const list = query({
  args: {
    limit: v.optional(v.number()),
    type: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    if (args.type) {
      return await ctx.db
        .query("logs")
        .withIndex("by_type", (q) => q.eq("type", args.type!))
        .order("desc")
        .take(limit);
    }
    return await ctx.db.query("logs").order("desc").take(limit);
  },
});

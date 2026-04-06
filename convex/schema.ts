import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  logs: defineTable({
    /**
     * Event type discriminator:
     *   user_message | assistant_text | thinking | tool_use |
     *   tool_result | result | system
     */
    type: v.string(),
    /** Primary text content for this log entry */
    content: v.string(),
    /** Arbitrary structured data (tool args, usage stats, etc.) */
    metadata: v.optional(v.any()),
    /** ISO-8601 timestamp */
    timestamp: v.string(),
    /** SDK session id for grouping turns */
    sessionId: v.optional(v.string()),
  })
    .index("by_timestamp", ["timestamp"])
    .index("by_type", ["type", "timestamp"])
    .index("by_session", ["sessionId", "timestamp"]),
});

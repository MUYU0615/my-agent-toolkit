# WeCom Intelligent Bot Long Connection

Official document:

`https://developer.work.weixin.qq.com/document/path/101463`

The page title is "智能机器人长连接".

## SDK

Prefer the official npm SDK:

```text
@wecom/aibot-node-sdk
```

The template uses:

- `WSClient` for the long connection.
- `message.text` for text messages.
- `sendMessage` for immediate acknowledgement.
- `replyStreamNonBlocking` for intermediate stream updates.
- `replyStream(..., finish=true)` for the final stream frame.
- `generateReqId("stream")` for stream IDs.

## Implementation Guidance

Before finalizing an implementation, check the installed SDK types and open the official document to verify:

- Required credentials and names for Bot ID and Secret.
- Token or signature acquisition flow.
- WebSocket or long-connection URL.
- Message receive payload schema.
- Stream reply schema.
- Stop/cancel or message update semantics, if any.
- Heartbeat requirements.
- Reconnect backoff rules.
- Error codes and retryable failures.

Keep all WeCom SDK/protocol details in `src/wecom/`. The rest of the runtime should call a small interface:

```ts
interface WeComClient {
  connect(): Promise<void>;
  onMessage(handler: (message: IncomingWeComMessage) => Promise<void>): void;
  sendText(conversationId: string, text: string): Promise<void>;
  startStream(replyKey: string): Promise<StreamHandle>;
}
```

The SDK's `BaseMessage.chatid` is only present for group chats. For single chats, use `from.userid` as the active conversation ID. Track the original callback frame per message so passive stream replies use the correct `headers.req_id`.

## Stream Reply Semantics

WeCom stream replies update the current content for a stream id. Treat `content` as the current full message body, not an append-only token delta.

Practical rules:

- Accumulate CLI stdout/stderr in memory.
- For intermediate stream updates, send the accumulated content, not the latest chunk alone.
- Throttle intermediate updates, for example one refresh every 500-1000 ms, to avoid high-frequency full-message repainting in WeCom clients.
- Send `replyStream(..., finish=true)` exactly once with the final accumulated content.
- Filter or remove transport-only lines such as `To resume this session: kimi -r ...` from the final user-visible content.

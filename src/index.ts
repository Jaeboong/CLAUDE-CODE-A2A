// 패키지 공개 표면. CLI(`a2ab`) 외에 브로커를 라이브러리로 쓰려는 소비자용 진입점이다.

export { Broker } from './broker.js';
export type {
  HeartbeatPatch,
  RegisterSessionInput,
  SendInput,
  SendResult,
} from './broker.js';

export { Store } from './store.js';

export {
  buildHookEntries,
  defaultSettingsPath,
  installHooks,
  mergeHooks,
  resolveA2abCommand,
} from './install.js';
export type {
  HookCommand,
  HookEntry,
  InstallOptions,
  InstallResult,
  MergeResult,
  Settings,
} from './install.js';

export {
  DEFAULT_NOTIFICATION_TTL_SECONDS,
  DEFAULT_REQUEST_DEADLINE_SECONDS,
  messageText,
  orderRequests,
} from './protocol.js';
export type {
  A2AMessage,
  InboxItem,
  InboxResult,
  MessageKind,
  MessageOrigin,
  MessagePart,
  NotificationDeliveryStatus,
  PathConflict,
  PeerSession,
  PeersResult,
  RequestDeliveryStatus,
  SessionRecord,
  SessionStatus,
  StoredMessage,
} from './protocol.js';

export {
  buildRequestInjection,
  handlePostToolUse,
  handleSessionEnd,
  handleSessionStart,
  handleStop,
} from './hooks.js';
export type { HookInput, HookOutput } from './hooks.js';

export { acquireLock, checkOnce, runWatch, watchLockPath } from './watch.js';
export type { RunWatchOptions, WatchContext, WatchResult, WatchTick } from './watch.js';

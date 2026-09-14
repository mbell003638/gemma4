/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Typed wrapper over the native Gemma bridge.
 *
 * Kept separate from `onDeviceLlm.ts` so Needle's call semantics are untouched:
 * Needle is the grammar-constrained path the app already depends on, and it
 * must keep working with no Gemma model installed at all.
 *
 * Every native response goes through `parseFrame`. Native output is JSON from a
 * process that just ran a language model over it, so it is parsed and bounded,
 * never cast.
 */
import type { Engine, NativeRequest, ToolResult } from '../accountingV2/gemma/agentCore';
import { parseFrame } from '../accountingV2/gemma/agentCore';

/** The bridge contract added alongside Needle in LedgrOnDeviceLlmModule. */
import { assertGemmaHealthy, markGemmaRecoveryRequired, gemmaRecoveryRequest, acknowledgeGemmaRecovery } from '../accountingV2/gemma/runtimeHealth';
import { bounded } from '../accountingV2/gemma/mediaDeadline';
import { MAX_DOCUMENT_PAGES } from '../accountingV2/gemma/documentOutput';
import { assertLifecycleAcknowledgement } from './gemmaLifecycleReply';

export type GemmaNative = {
  gemmaBegin(json: string): Promise<string>;
  gemmaResume(json: string): Promise<string>;
  gemmaCancel(requestId: string): Promise<void>;
  gemmaFinish(requestId: string): Promise<string>;
};

export type GemmaPackState = { state: string; bytesOnDisk: number; partialBytes: number; unsupportedReason?: string | null };
export type GemmaRuntimeStatus = {
  managementOperation?: string | null;
  recoveryRequired?: boolean;
  supported: boolean;
  bridgeVersion: number;
  capabilities: string[];
  packs: Record<string, GemmaPackState>;
};
type GemmaManagementNative = GemmaNative & {
  getStatus(): Promise<{ gemmaBridgeVersion?: number; gemmaCapabilities?: string[]; gemmaPacks?: Record<string, GemmaPackState> }>;
  gemmaDownload(modelId: string): Promise<string>;
  gemmaPauseDownload(modelId: string): Promise<boolean>;
  gemmaDiscardPartial(modelId: string): Promise<string>;
  gemmaRemove(modelId: string): Promise<string>;
  gemmaRecover(requestId: string): Promise<string>;
  gemmaPrepareImage(uri: string, requestId: string): Promise<string>;
  gemmaPreparePdfPage(uri: string, pageIndex: number, requestId: string): Promise<string>;
  gemmaPrepareAudio(uri: string, requestId: string): Promise<string>;
  gemmaDiscardAttachments(requestId: string): Promise<string>;
};

export type InstalledGemmaRuntime = { modelId: string; engine: Engine };
export type PreparedGemmaImage = { handle: string; pageCount: number; excludedPages: number };
export type PreparedGemmaAudio = { handle: string; durationMs: number; sampleRate: number };

function objectFrame(raw: string): Record<string, unknown> {
  if (typeof raw !== 'string') throw new Error('GEMMA_MEDIA_FRAME_INVALID');
  if (raw.length > 16_384) throw new Error('GEMMA_MEDIA_FRAME_TOO_LARGE');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('GEMMA_MEDIA_FRAME_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GEMMA_MEDIA_FRAME_INVALID');
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) throw new Error(`GEMMA_MEDIA_${field}_INVALID`);
  return value;
}

function boundedInteger(value: unknown, field: string, max: number): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > max) throw new Error(`GEMMA_MEDIA_${field}_INVALID`);
  return value as number;
}

async function mediaNative(capability: 'vision' | 'audio'): Promise<Partial<GemmaManagementNative>> {
  assertGemmaHealthy();
  const native = managementNative();
  if (!native?.getStatus) throw new Error('GEMMA_BRIDGE_UNAVAILABLE');
  const status = await native.getStatus();
  if (!supportsGemmaBridge(status)) throw new Error('GEMMA_BRIDGE_UNAVAILABLE');
  assertGemmaHealthy();
  if ((status as { gemmaRecoveryRequired?: boolean }).gemmaRecoveryRequired) throw new Error('NATIVE_RECOVERY_REQUIRED');
  if ((status as { gemmaManagementOperation?: string | null }).gemmaManagementOperation) throw new Error('GEMMA_BUSY');
  const capabilities = Array.isArray(status.gemmaCapabilities) ? status.gemmaCapabilities : [];
  if (!capabilities.includes(capability)) throw new Error(`GEMMA_${capability.toUpperCase()}_UNVERIFIED`);
  return native;
}

export function parsePreparedGemmaImage(raw: string): PreparedGemmaImage {
  const value = objectFrame(raw);
  return {
    handle: boundedString(value.handle, 'HANDLE'),
    pageCount: boundedInteger(value.pageCount, 'PAGE_COUNT', 10_000),
    excludedPages: boundedInteger(value.excludedPages, 'EXCLUDED_PAGES', 10_000),
  };
}

export function parsePreparedGemmaAudio(raw: string): PreparedGemmaAudio {
  const value = objectFrame(raw);
  return {
    handle: boundedString(value.handle, 'HANDLE'),
    durationMs: boundedInteger(value.durationMs, 'DURATION', 60_000),
    sampleRate: boundedInteger(value.sampleRate, 'SAMPLE_RATE', 192_000),
  };
}

/** Media remains unavailable until the installed APK explicitly verifies vision/audio. */
export async function prepareGemmaImage(uri: string, requestId: string): Promise<PreparedGemmaImage> {
  const native = await mediaNative('vision');
  if (!native.gemmaPrepareImage) throw new Error('GEMMA_VISION_UNAVAILABLE');
  return parsePreparedGemmaImage(await native.gemmaPrepareImage(uri, requestId));
}

export async function prepareGemmaPdfPage(uri: string, pageIndex: number, requestId: string): Promise<PreparedGemmaImage> {
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= MAX_DOCUMENT_PAGES) throw new Error('GEMMA_PDF_PAGE_LIMIT');
  const native = await mediaNative('vision');
  if (!native.gemmaPreparePdfPage) throw new Error('GEMMA_VISION_UNAVAILABLE');
  return parsePreparedGemmaImage(await native.gemmaPreparePdfPage(uri, pageIndex, requestId));
}

export async function prepareGemmaAudio(uri: string, requestId: string): Promise<PreparedGemmaAudio> {
  const native = await mediaNative('audio');
  if (!native.gemmaPrepareAudio) throw new Error('GEMMA_AUDIO_UNAVAILABLE');
  return parsePreparedGemmaAudio(await native.gemmaPrepareAudio(uri, requestId));
}

export async function discardGemmaAttachments(requestId: string): Promise<number> {
  const native = managementNative();
  if (!native?.gemmaDiscardAttachments) throw new Error('GEMMA_BRIDGE_UNAVAILABLE');
  if (!(await gemmaPackStatus()).supported) throw new Error('GEMMA_BRIDGE_TOO_OLD');
  const removed = objectFrame(await native.gemmaDiscardAttachments(requestId)).removed;
  if (typeof removed !== 'number' || !Number.isInteger(removed) || removed < 0) throw new Error('GEMMA_MANAGEMENT_REPLY_INVALID');
  return removed;
}

function managementNative(): Partial<GemmaManagementNative> | null {
  try {
    const { NativeModules, Platform } = require('react-native');
    if (Platform.OS !== 'android') return null;
    return require('expo-modules-core').requireOptionalNativeModule('LedgrOnDeviceLlm')
      || NativeModules.LedgrOnDeviceLlm || null;
  } catch { return null; }
}

export async function gemmaPackStatus(): Promise<GemmaRuntimeStatus> {
  const native = managementNative();
  if (!native?.getStatus) return { supported: false, bridgeVersion: 0, capabilities: [] as string[], packs: {} as Record<string, GemmaPackState> };
  const status = await native.getStatus();
  const management = status as typeof status & { gemmaManagementOperation?: string; gemmaRecoveryRequired?: boolean };
  return { supported: supportsGemmaBridge(status), managementOperation: management.gemmaManagementOperation, recoveryRequired: management.gemmaRecoveryRequired || gemmaRecoveryRequest() !== null, bridgeVersion: Number(status.gemmaBridgeVersion || 0), capabilities: Array.isArray(status.gemmaCapabilities) ? status.gemmaCapabilities : [], packs: status.gemmaPacks || {} };
}

/** True only when native verified the modality and a checksum-verified pack is ready. */
export function hasReadyGemmaCapability(status: GemmaRuntimeStatus, capability: 'text' | 'tools' | 'vision' | 'audio'): boolean {
  return status.supported
    && !status.recoveryRequired
    && !status.managementOperation
    && gemmaRecoveryRequest() === null
    && status.capabilities.includes(capability)
    && Object.values(status.packs).some((pack) => pack.state === 'ready');
}

/** Resolve only a bridge-verified, checksum-verified installed pack. */
export async function installedGemmaRuntime(): Promise<InstalledGemmaRuntime | null> {
  assertGemmaHealthy();
  const health = await gemmaPackStatus();
  if (health.recoveryRequired) throw new Error('NATIVE_RECOVERY_REQUIRED');
  if (health.managementOperation || Object.values(health.packs).some(pack => pack.state === 'verifying')) throw new Error('GEMMA_VERIFYING');
  const native = managementNative();
  if (!native?.getStatus || !native.gemmaBegin || !native.gemmaResume || !native.gemmaCancel || !native.gemmaFinish) return null;
  const status = await native.getStatus();
  if (!supportsGemmaBridge(status)) return null;
  assertGemmaHealthy();
  const currentHealth = status as { gemmaRecoveryRequired?: boolean; gemmaManagementOperation?: string | null };
  if (currentHealth.gemmaRecoveryRequired) throw new Error('NATIVE_RECOVERY_REQUIRED');
  if (currentHealth.gemmaManagementOperation) throw new Error('GEMMA_BUSY');
  const capabilities = Array.isArray(status.gemmaCapabilities) ? status.gemmaCapabilities : [];
  if (!capabilities.includes('text') || !capabilities.includes('tools')) return null;
  const packs = status.gemmaPacks || {};
  const modelId = ['gemma4-e4b', 'gemma4-e2b'].find((id) => packs[id]?.state === 'ready');
  return modelId ? { modelId, engine: createGemmaEngine(native as GemmaNative) } : null;
}

export async function downloadGemmaPack(modelId: string): Promise<void> {
  assertGemmaHealthy();
  const native = managementNative();
  if (!native?.gemmaDownload || !(await gemmaPackStatus()).supported) throw new Error('GEMMA_BRIDGE_UNAVAILABLE');
  await native.gemmaDownload(modelId);
}
export async function pauseGemmaDownload(modelId: string): Promise<boolean> {
  const native = managementNative();
  return native?.gemmaPauseDownload ? native.gemmaPauseDownload(modelId) : false;
}
export async function discardGemmaPartial(modelId: string): Promise<boolean> {
  const native = managementNative();
  if (!native?.gemmaDiscardPartial || !(await gemmaPackStatus()).supported) throw new Error('GEMMA_BRIDGE_UNAVAILABLE');
  const removed = objectFrame(await native.gemmaDiscardPartial(modelId)).removed;
  if (typeof removed !== 'boolean') throw new Error('GEMMA_MANAGEMENT_REPLY_INVALID');
  return removed;
}
export async function removeGemmaPack(modelId: string): Promise<boolean> {
  const native = managementNative();
  if (!native?.gemmaRemove || !(await gemmaPackStatus()).supported) throw new Error('GEMMA_BRIDGE_UNAVAILABLE');
  const removed = objectFrame(await native.gemmaRemove(modelId)).removed;
  if (typeof removed !== 'boolean') throw new Error('GEMMA_MANAGEMENT_REPLY_INVALID');
  return removed;
}

/** Explicit recovery never unloads a different request. Poisoned JNI requires restart. */
export async function recoverGemmaRuntime(): Promise<void> {
  const native = managementNative();
  if (!native?.getStatus || !native.gemmaRecover) throw new Error('GEMMA_BRIDGE_UNAVAILABLE');
  const requestId = gemmaRecoveryRequest();
  const status = await bounded(() => Promise.resolve(native.getStatus!()), 5000, 'NATIVE_CLEANUP_TIMEOUT') as { gemmaRecoveryRequired?: boolean; gemmaAdmittedRequestId?: string | null };
  if (status.gemmaRecoveryRequired) throw new Error('RESTART_APP_REQUIRED');
  if (!requestId) return;
  if (status.gemmaAdmittedRequestId && status.gemmaAdmittedRequestId !== requestId) throw new Error('GEMMA_BUSY');
  // An idle snapshot cannot acknowledge queued cleanup.
  const ack = await bounded(() => native.gemmaRecover!(requestId), 5000, 'NATIVE_CLEANUP_TIMEOUT');
  assertLifecycleAcknowledgement(ack, requestId);
  acknowledgeGemmaRecovery(requestId);
}

/**
 * The bridge protocol version this JS expects.
 *
 * An APK built before the Gemma host exists still exposes `LedgrOnDeviceLlm`
 * for Needle, so the module being present proves nothing. Check the version
 * reported by `getStatus()` before constructing an engine.
 */
export const REQUIRED_GEMMA_BRIDGE_VERSION = 3;

export function supportsGemmaBridge(status: { gemmaBridgeVersion?: number } | null | undefined): boolean {
  const version = status?.gemmaBridgeVersion;
  return typeof version === 'number' && version >= REQUIRED_GEMMA_BRIDGE_VERSION;
}

export function createGemmaEngine(native: GemmaNative): Engine {
  return {
    begin: async (request: NativeRequest) => {
      assertGemmaHealthy();
      return parseFrame(await native.gemmaBegin(JSON.stringify(request)));
    },
    resume: async (requestId: string, results: ToolResult[]) => {
      assertGemmaHealthy();
      return parseFrame(await native.gemmaResume(JSON.stringify({ requestId, results })));
    },
    cancel: (requestId: string) => native.gemmaCancel(requestId),
    finish: async (requestId: string) => {
      try { assertLifecycleAcknowledgement(await native.gemmaFinish(requestId), requestId); }
      catch (error) { markGemmaRecoveryRequired(requestId); throw error; }
    },
  };
}

import type { EntryHelpOrder, OcrProvider } from '../db/ai';
import { DEFAULT_ENTRY_HELP_ORDER, withCloudHelpTimeout } from '../db/ai';
import { parseLocalDocumentText, type LocalDocumentParserOptions, type LocalDocumentParseResult } from './localDocumentParser';

export type DocumentAnalysisInput = { base64?: string; mimeType?: string; text?: string; uri?: string };
export type DocumentAnalysisRoute = {
  analysis: Record<string, unknown>;
  source: 'local' | 'cloud' | 'on-device-llm';
  extractedText?: string;
  notice?: string;
  pending?: Extract<LocalDocumentParseResult, { kind: 'clarification' }>;
};

type RouteRequest = {
  input: DocumentAnalysisInput;
  mode: OcrProvider;
  hasCloudAI: boolean;
  recognizeLocal: (uri: string) => Promise<string>;
  analyzeCloud: (input: DocumentAnalysisInput) => Promise<unknown>;
  analyzeOnDevice?: (input: DocumentAnalysisInput) => Promise<unknown>;
  parserOptions?: LocalDocumentParserOptions;
  entryHelpOrder?: EntryHelpOrder;
};

function localRoute(text: string, options?: LocalDocumentParserOptions): DocumentAnalysisRoute | null {
  const parsed = parseLocalDocumentText(text, options);
  if (parsed.kind === 'unsupported') return null;
  const inferred = parsed.evidence?.selectedTotalLabel === 'visible amount';
  return {
    analysis: parsed.analysis as Record<string, unknown>,
    source: 'local',
    extractedText: parsed.sourceText,
    ...(parsed.kind === 'clarification' ? { notice: parsed.question, pending: parsed } : inferred ? { notice: 'Amount was inferred from visible figures. Confirm it before import.' } : {}),
  };
}

async function extractLocal(request: RouteRequest): Promise<{ text: string; failure: string }> {
  let extractedText = request.input.text?.trim() || '';
  let failure = '';
  const canOcr = Boolean(request.input.uri && (request.input.mimeType?.startsWith('image/') || request.input.mimeType === 'application/pdf'));
  if (!extractedText && canOcr && request.input.uri) {
    try { extractedText = await request.recognizeLocal(request.input.uri); }
    catch (error: any) { failure = error?.message || 'Local OCR could not read this document.'; }
  }
  if (!extractedText && !failure) {
    failure = request.input.mimeType === 'application/pdf'
      ? 'On-device PDF OCR could not read this file. Try page images or paste the PDF text.'
      : 'Local OCR needs an Android image or PDF URI, or pasted document text.';
  }
  return { text: extractedText, failure };
}

/** Routes OCR and document interpretation without ever posting ledger data. */
export async function analyzeDocumentLocalFirst(request: RouteRequest): Promise<DocumentAnalysisRoute> {
  const order = request.entryHelpOrder || DEFAULT_ENTRY_HELP_ORDER;
  const runCloud = () => withCloudHelpTimeout(Promise.resolve(request.analyzeCloud(request.input)));
  const runLocal = async (): Promise<DocumentAnalysisRoute | { failure: string }> => {
    const extracted = await extractLocal(request);
    if (extracted.text) {
      const local = localRoute(extracted.text, request.parserOptions);
      if (local) return local;
      return { failure: 'Local OCR text did not contain enough accounting information.' };
    }
    return { failure: extracted.failure };
  };

  if (request.mode === 'android-device') {
    const local = await runLocal();
    if ('analysis' in local) return local;
    if (request.analyzeOnDevice) {
      try {
        return {
          analysis: await request.analyzeOnDevice(request.input) as Record<string, unknown>,
          source: 'on-device-llm',
          notice: 'On-device Gemma prepared this draft because local OCR did not find enough ledger lines.',
        };
      } catch (error) {
        const { gemmaMediaErrorMessage } = await import('./gemma/mediaTasks');
        throw new Error(gemmaMediaErrorMessage(error));
      }
    }
    throw new Error(local.failure || 'The document needs more information before Ledgr can prepare a draft.');
  }

  if (request.mode === 'cloud' || (request.mode === 'auto' && order === 'cloud-first' && request.hasCloudAI)) {
    try {
      return { analysis: await runCloud() as Record<string, unknown>, source: 'cloud' };
    } catch (error: any) {
      if (request.mode === 'cloud') throw error;
      const local = await runLocal();
      if ('analysis' in local) {
        return { ...local, notice: [local.notice, 'Cloud analysis failed or timed out, so on-device OCR prepared this draft instead.'].filter(Boolean).join(' ') };
      }
      throw new Error(`${error?.message || 'Cloud document analysis failed.'} ${local.failure}`.trim());
    }
  }

  const local = await runLocal();
  if ('analysis' in local) {
    return local;
  }
  if (request.hasCloudAI) {
    try {
      return { analysis: await runCloud() as Record<string, unknown>, source: 'cloud' };
    } catch (error: any) {
      throw new Error(`${error?.message || 'Cloud document analysis failed.'} ${local.failure}`.trim());
    }
  }
  throw new Error(`${local.failure || 'Local document extraction was insufficient.'} Configure an AI key for cloud vision, or edit and paste the document text.`);
}

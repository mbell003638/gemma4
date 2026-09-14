import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Modal, TextInput, Keyboard, Platform, ScrollView, useWindowDimensions, type KeyboardEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useAudioRecorder, RecordingPresets } from "expo-audio";
import { useAnimations, useTheme } from "@/src/context/ThemeContext";
import { api, getAIConfig } from "@/src/api";
import { effectiveVoiceProvider, isOnDeviceInterpretation } from "@/src/db/ai";
import { executeAssistantProposal, type AssistantProposalValidationResult } from "@/src/accountingV2/aiActions";
import { materializePendingVoiceParty, type VoicePartyCreateProposal } from "@/src/accountingV2/voicePartyResolution";
import { buildVoiceTransactionDraft, resolveAgainstInvoiceTarget, resolveVoiceCommandsForDrafts, unpaidInvoicesForCustomer, type VoiceTransactionDraft } from "@/src/accountingV2/voiceTransactionDraft";
import { BlurView } from "expo-blur";
import { fmt } from "@/src/theme";
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, withSequence, Easing, SlideInDown } from "react-native-reanimated";
import { localTodayIso } from "@/src/utils/dateValidation";
import { captureVoiceRecording, cancelVoiceRecorder, friendlyVoiceError, startVoiceRecorder } from "@/src/utils/voiceRecorder";
import { getDeviceSpeechStatus, startDeviceSpeechRecognition } from "@/src/utils/deviceSpeechRecognizer";
import { continueVoiceTransaction, interpretVoiceTransaction, type PendingVoiceClarification, type VoiceInterpretationResult } from "@/src/accountingV2/voiceInterpretationRouter";
import { interpretNeedleVoiceCommand } from "@/src/utils/onDeviceLlm";
import { speakOnDevice } from "@/src/utils/deviceTts";
import { gemmaPackStatus, hasReadyGemmaCapability } from "@/src/utils/gemmaNative";

type Phase = "idle" | "recording" | "processing" | "confirm" | "error";

export default function VoiceFab() {
  const theme = useTheme();
  const { motionEnabled } = useAnimations();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [phase, setPhase] = useState<Phase>("idle");
  const [transcript, setTranscript] = useState("");
  const [parsed, setParsed] = useState<any>(null);
  const [drafts, setDrafts] = useState<VoiceTransactionDraft[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [validatedAction, setValidatedAction] = useState<AssistantProposalValidationResult | null>(null);
  const [pendingClarification, setPendingClarification] = useState<PendingVoiceClarification | null>(null);
  const [followUpAnswer, setFollowUpAnswer] = useState("");
  const [createProposal, setCreateProposal] = useState<VoicePartyCreateProposal | null>(null);
  const [bookCurrency, setBookCurrency] = useState("USD");
  const deviceStopRef = useRef<(() => Promise<void>) | null>(null);
  const transcriptRef = useRef("");

  const pulseScale = useSharedValue(1);
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const handleShow = (e: KeyboardEvent) => {
      setKeyboardHeight(e.endCoordinates?.height ?? 0);
    };
    const handleHide = () => {
      setKeyboardHeight(0);
    };
    const showSub = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", handleShow);
    const hideSub = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", handleHide);
    const frameSub = Keyboard.addListener("keyboardDidChangeFrame", handleShow);
    return () => {
      showSub.remove();
      hideSub.remove();
      frameSub.remove();
    };
  }, []);

  const popupBottomPadding = keyboardHeight > 0 ? keyboardHeight + 8 : Math.max(insets.bottom, 16);
  const maxPopupHeight = Math.max(240, windowHeight - (keyboardHeight > 0 ? keyboardHeight : insets.bottom) - insets.top - 24);

  useEffect(() => () => { void deviceStopRef.current?.(); deviceStopRef.current = null; void cancelVoiceRecorder(recorder); }, [recorder]);

  useEffect(() => {
    if (phase === "recording") {
      if (!motionEnabled) { pulseScale.value = 1; return; }
      pulseScale.value = withRepeat(
        withSequence(
          withTiming(1.1, { duration: 800, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: 800, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        true
      );
    } else {
      pulseScale.value = withTiming(1);
    }
  }, [motionEnabled, phase, pulseScale]);

  useEffect(() => {
    if (phase !== "confirm") return;
    const preview = validatedAction && validatedAction.ok ? validatedAction.action.confirmation.preview : "Draft ready for confirmation.";
    void api.getSpeakAnswers().then((enabled) => { if (enabled) return speakOnDevice(preview); }).catch(() => undefined);
  }, [phase, validatedAction]);

  const draftFromInterpretation = async (interpretation: VoiceInterpretationResult) => {
    if (interpretation.kind === "clarification") {
      setPendingClarification(interpretation);
      throw new Error(interpretation.question);
    }
    if (interpretation.kind === "unsupported") {
      throw new Error(`${interpretation.reason} You can edit the transcript${(await getAIConfig()).interpretationMode === "device-only" ? " or enable Automatic cloud fallback in Settings" : ""}.`);
    }
    const [suppliers, customers, capitalAccounts] = await Promise.all([
      api.listSuppliers(), api.listDebtors(), api.listInvestors(),
    ]);
    const commands = interpretation.commands?.length ? interpretation.commands : [interpretation.command];
    const resolution = resolveVoiceCommandsForDrafts(commands, interpretation.transcript, { suppliers, customers, capitalAccounts });
    if (!resolution.ok) {
      setCreateProposal(resolution.createProposal || null);
      setPendingClarification({ kind: "clarification", confidence: "low", command: resolution.command, field: "party", question: resolution.question, transcript: interpretation.transcript });
      throw new Error(resolution.question);
    }
    const ready: VoiceTransactionDraft[] = [];
    for (let resolvedCommand of resolution.commands) {
    if (!resolvedCommand.method && ["expense", "receipt", "supplier_payment", "drawing", "capital"].includes(String(resolvedCommand.intent))) {
      resolvedCommand = { ...resolvedCommand, method: "cash" };
    }
    if (resolvedCommand.intent === "receipt" && resolvedCommand.receiptMode === "against_invoice" && resolvedCommand.customerName) {
      const customer = customers.find((item: any) => item.name.trim().toLowerCase() === String(resolvedCommand.customerName).trim().toLowerCase());
      const unpaid = unpaidInvoicesForCustomer(await api.listInvoices(), customer, resolvedCommand.customerName);
      const target = resolveAgainstInvoiceTarget(resolvedCommand, unpaid);
      resolvedCommand = "mode" in target ? { ...resolvedCommand, receiptMode: "advance" } : { ...resolvedCommand, invoiceId: target.invoiceId };
    }
    ready.push(buildVoiceTransactionDraft(resolvedCommand));
    }
    setPendingClarification(null);
    setFollowUpAnswer("");
    setCreateProposal(null);
    return ready;
  };
  const buildVoiceDraft = async (txt: string) => {
    setPendingClarification(null);
    setFollowUpAnswer("");
    setCreateProposal(null);
    setTranscript(txt);
    const [cfg, settings] = await Promise.all([getAIConfig(), api.getSettings()]);
    setBookCurrency(settings.currency || "USD");
    const interpretation = await interpretVoiceTransaction({
      transcript: txt,
      mode: cfg.interpretationMode || "auto",
      hasCloudAI: Boolean(cfg.apiKey),
      parseCloud: api.parseCommand,
      parseNeedle: (text) => interpretNeedleVoiceCommand(text),
      parserOptions: { defaultCurrency: settings.currency || "USD", requirePaymentMethod: false },
      entryHelpOrder: cfg.entryHelpOrder,
    });
    return draftFromInterpretation(interpretation);
  };
  const continueDraft = async (answer = followUpAnswer) => {
    if (!pendingClarification || !answer.trim()) return;
    setError(""); setPhase("processing");
    try {
      const [settings, suppliers, customers, capitalAccounts] = await Promise.all([
        api.getSettings(), api.listSuppliers(), api.listDebtors(), api.listInvestors(),
      ]);
      const currentPending = {
        ...pendingClarification,
        transcript: transcript.trim() || pendingClarification.transcript,
      };
      const interpretation = continueVoiceTransaction(currentPending, answer, {
        defaultCurrency: settings.currency || "USD",
        requirePaymentMethod: false,
        directory: { suppliers, customers, capitalAccounts },
      });
      if (interpretation.kind !== "command") {
        if (interpretation.kind === "clarification") setPendingClarification(interpretation);
        throw new Error(interpretation.kind === "clarification" ? interpretation.question : interpretation.reason);
      }
      setTranscript(interpretation.transcript);
      const ready = await draftFromInterpretation(interpretation);
      setDrafts(ready); setParsed(ready[0]?.parsed || null); setValidatedAction(ready[0]?.validation || null); setPhase("confirm");
    } catch (e: any) { setError(e?.message || "Could not continue the draft."); setPhase("error"); }
  };
  const start = async () => {
    setError(""); setTranscript(""); setParsed(null); setDrafts([]); setPendingClarification(null); setFollowUpAnswer(""); setCreateProposal(null);
    try {
      if (deviceStopRef.current) { await deviceStopRef.current().catch(() => {}); deviceStopRef.current = null; }
      await cancelVoiceRecorder(recorder);
      const cfg = await getAIConfig();
      const mode = effectiveVoiceProvider(cfg);
      if (mode !== "cloud") {
        const status = await getDeviceSpeechStatus();
        if (status.available) {
          transcriptRef.current = "";
          deviceStopRef.current = await startDeviceSpeechRecognition({ onPartial: (text) => { transcriptRef.current = text; setTranscript(text); }, onFinal: (text) => { transcriptRef.current = text; setTranscript(text); }, onError: (speechError) => { setError(speechError.message); setPhase("error"); } }, { onDeviceOnly: isOnDeviceInterpretation(cfg) });
          setPhase("recording");
          return;
        }
        if (mode === "android-device") {
          const gemma = await gemmaPackStatus();
          if (!hasReadyGemmaCapability(gemma, 'audio')) throw new Error(status.reason || "Android device speech recognition and Gemma audio are unavailable.");
        }
      }
      await startVoiceRecorder(recorder);
      setPhase("recording");
    } catch (e: any) { setError(friendlyVoiceError(e, "Could not start the microphone.")); setPhase("error"); }
  };

  const stopAndProcess = async () => {
    setPhase("processing");
    try {
      let txt = "";
      if (deviceStopRef.current) { await deviceStopRef.current(); deviceStopRef.current = null; txt = transcriptRef.current.trim(); }
      else { const captured = await captureVoiceRecording(recorder); const t = await api.transcribe(captured.audioBase64, captured.mime, captured.uploadUri); txt = (t.transcript || "").trim(); }
      if (!txt) throw new Error("Nothing was heard. Try again.");
      setTranscript(txt);
      
      const ready = await buildVoiceDraft(txt);
      setDrafts(ready);
      setParsed(ready[0]?.parsed || null);
      setValidatedAction(ready[0]?.validation || null);
      setPhase("confirm");
    } catch (e: any) {
      setError(friendlyVoiceError(e, "Voice processing failed"));
      setPhase("error");
    }
  };

  const rebuildDraft = async () => {
    const txt = transcript.trim();
    if (!txt) return;
    setError(""); setPhase("processing");
    setPendingClarification(null);
    setFollowUpAnswer("");
    setCreateProposal(null);
    try {
      const ready = await buildVoiceDraft(txt);
      setDrafts(ready);
      setParsed(ready[0]?.parsed || null);
      setValidatedAction(ready[0]?.validation || null);
      setPhase("confirm");
    } catch (e: any) {
      setError(e?.message || "Could not update the draft from that transcript.");
      setPhase("error");
    }
  };
  const confirmSave = async () => {
    const toSave = drafts.length ? drafts : (parsed && validatedAction?.ok ? [{ parsed, validation: validatedAction }] : []);
    if (!toSave.length) return;
    setSaving(true);
    try {
      const currency = (await api.getSettings()).currency || "USD";
      for (const draft of toSave) {
      const parsedDraft = draft.parsed;
      const date = parsedDraft.date || localTodayIso();
      if (!draft.validation || !draft.validation.ok) throw new Error("Voice action requires validation before saving.");
      await executeAssistantProposal(draft.validation, { confirmed: true }, async () => {
        const command = await materializePendingVoiceParty(parsedDraft, {
          supplier: (name) => api.createSupplier({ name }),
          customer: (name) => api.createDebtor({ name }),
        });
        Object.assign(parsedDraft, command);
        if (parsedDraft.intent === "expense") {
          await api.createExpense({ date, amount: parsedDraft.amount, currency, category: parsedDraft.category || "General", notes: parsedDraft.notes || parsedDraft.summary, method: parsedDraft.method || "cash" });
        } else if (parsedDraft.intent === "bill") {
          const list = await api.listSuppliers();
          const match = list.filter((supplier: any) => supplier.name.trim().toLowerCase() === String(parsedDraft.supplierName || "").trim().toLowerCase());
          if (match.length !== 1) throw new Error(`Supplier "${parsedDraft.supplierName}" was not found uniquely. Add or choose the exact Supplier first.`);
          await api.createBill({
            supplierId: match[0].id, date, amount: parsedDraft.amount, currency,
            paymentType: parsedDraft.paymentType === "cash" ? "cash" : "credit",
            notes: parsedDraft.notes || parsedDraft.summary,
          });
        } else if (parsedDraft.intent === "sale") {
          await api.createSale({ date, amount: parsedDraft.amount, currency, notes: parsedDraft.notes || parsedDraft.summary });
        } else if (parsedDraft.intent === "receipt") {
          let mode = parsedDraft.receiptMode || (parsedDraft.customerName ? "against_invoice" : "cash_sale");
          const method = parsedDraft.method || "cash";
          if (!parsedDraft.customerName || mode === "cash_sale") {
            await api.createSale({ date, amount: parsedDraft.amount, currency, notes: parsedDraft.notes || parsedDraft.summary, method });
          } else {
            let debtorId: string | null = null;
            let allocations: { invoiceId: string; amountApplied: number }[] = [];
            const debtors = await api.listDebtors();
            const match = debtors.find((d: any) => d.name.trim().toLowerCase() === parsedDraft.customerName.trim().toLowerCase());
            if (match) debtorId = match.id;
            else throw new Error(`Customer "${parsedDraft.customerName}" was not found. Add the Customer first.`);
            if (mode === "against_invoice") {
              const unpaid = unpaidInvoicesForCustomer(await api.listInvoices(), match, parsedDraft.customerName);
              const target = resolveAgainstInvoiceTarget(parsedDraft, unpaid);
              if ("mode" in target) mode = "advance";
              else allocations = [{ invoiceId: target.invoiceId, amountApplied: parsedDraft.amount }];
            }
            await api.createReceipt({
              mode, date, amount: parsedDraft.amount, method,
              debtorId, clientName: parsedDraft.customerName,
              allocations, notes: parsedDraft.notes || parsedDraft.summary,
            });
          }
        } else if (parsedDraft.intent === "supplier_payment") {
          const list = await api.listSuppliers();
          const match = list.filter((s: any) => s.name.trim().toLowerCase() === String(parsedDraft.supplierName || "").trim().toLowerCase());
          if (match.length !== 1) throw new Error(`Supplier "${parsedDraft.supplierName}" was not found uniquely. Add or choose the exact Supplier first.`);
          await api.createPayment({
            date, amount: parsedDraft.amount, currency,
            type: "supplier_payment", supplierId: match[0].id,
            method: parsedDraft.method || "cash", notes: parsedDraft.notes || parsedDraft.summary,
          });
        } else if (parsedDraft.intent === "drawing") {
          const members = await api.listInvestors();
          const match = members.filter((member: any) => member.name.trim().toLowerCase() === String(parsedDraft.partnerName || "").trim().toLowerCase());
          if (match.length !== 1) throw new Error(`Capital Account "${parsedDraft.partnerName}" was not found uniquely.`);
          await api.drawInvestorFunds(match[0].id, { date, amount: parsedDraft.amount, method: parsedDraft.method || "cash", notes: parsedDraft.notes || parsedDraft.summary });
        } else if (parsedDraft.intent === "capital") {
          const members = await api.listInvestors();
          const match = members.filter((member: any) => member.name.trim().toLowerCase() === String(parsedDraft.partnerName || "").trim().toLowerCase());
          if (match.length !== 1) throw new Error(`Capital Account "${parsedDraft.partnerName}" was not found uniquely.`);
          await api.depositInvestorCapital(match[0].id, { date, amount: parsedDraft.amount, notes: parsedDraft.notes || parsedDraft.summary });
        } else if (parsedDraft.intent === "inventory") {
          await api.recordV2InventoryCount({ date, value: Number(parsedDraft.amount), notes: parsedDraft.notes || parsedDraft.summary });
        } else {
          throw new Error("Could not determine intent. Please try again.");
        }
      });
      }
      reset();
    } catch (e: any) {
      setError(e.message || "Save failed");
      setPhase("error");
    } finally { setSaving(false); }
  };

  const reset = () => {
    void deviceStopRef.current?.(); deviceStopRef.current = null;
    void cancelVoiceRecorder(recorder);
    setPhase("idle"); setTranscript(""); setParsed(null); setDrafts([]); setValidatedAction(null); setError(""); setPendingClarification(null); setFollowUpAnswer(""); setCreateProposal(null);
  };

  const isModalOpen = phase !== "idle";

  const animatedMicStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
  }));

  return (
    <>
      <Pressable
        testID="voice-fab"
        onPress={start}
        style={({ pressed }) => [
          styles.fab,
          { backgroundColor: theme.color.brandPrimary },
          pressed && { opacity: 0.85, transform: [{ scale: 0.96 }] },
        ]}
      >
        <Ionicons name="mic" size={26} color={theme.color.onBrandPrimary} />
      </Pressable>

      <Modal transparent visible={isModalOpen} animationType="fade" onRequestClose={reset}>
        <View style={[styles.overlayContainer, { paddingBottom: popupBottomPadding }]}>
          <Pressable style={styles.overlayPressable} onPress={reset}>
            <BlurView intensity={20} tint="dark" style={StyleSheet.absoluteFill} />
            <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)' }]} />
          </Pressable>

          <Animated.View entering={SlideInDown.duration(300).springify()} style={[styles.popupContainer, { backgroundColor: theme.color.surface, maxHeight: maxPopupHeight }]}>
            {/* Header / Dismiss */}
            <View style={styles.popupHeader}>
              <Text style={[styles.popupTitle, { color: theme.color.onSurface }]}>Voice Assistant</Text>
              <Pressable onPress={reset} accessibilityRole="button" accessibilityLabel="Dismiss voice assistant" style={({pressed}) => [pressed && {opacity: 0.5}]}>
                <Ionicons name="close-circle" size={28} color={theme.color.muted} />
              </Pressable>
            </View>

            <ScrollView
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              style={styles.popupScroll}
              contentContainerStyle={styles.popupScrollContent}
            >
              {phase === "recording" || phase === "processing" ? (
                <View style={styles.recordingBox}>
                  <Text style={[styles.hintText, { color: theme.color.muted }]}>
                    “Paid 100 to Amit and 50 to Rahim”
                  </Text>
                  <Animated.View style={animatedMicStyle}>
                    <Pressable 
                      onPress={phase === "recording" ? stopAndProcess : undefined} 
                      style={[styles.bigMicBtn, { backgroundColor: phase === "recording" ? theme.color.error : theme.color.surfaceTertiary }]}
                    >
                      {phase === "processing" ? (
                         <ActivityIndicator color={theme.color.onSurface} size="large" />
                      ) : (
                         <Ionicons name="stop" size={44} color="#fff" />
                      )}
                    </Pressable>
                  </Animated.View>
                  <Text style={[styles.statusLabel, { color: theme.color.brandPrimary }]}>
                    {phase === "recording" ? "Listening... Tap to stop" : "Transcribing AI..."}
                  </Text>
                </View>
              ) : phase === "confirm" && (drafts.length || parsed) ? (
                <View style={[styles.draftBox, { backgroundColor: theme.color.surfaceSecondary }]}>
                  {transcript ? (
                    <View style={[styles.transcriptBubble, { backgroundColor: theme.color.surfaceTertiary }]}>
                      <TextInput accessibilityLabel="Editable homepage voice transcript" value={transcript} onChangeText={setTranscript} multiline autoCorrect onSubmitEditing={Keyboard.dismiss} style={{ fontStyle: "italic", color: theme.color.onSurface }} />
                      <Pressable accessibilityRole="button" accessibilityLabel="Update homepage voice draft" onPress={() => void rebuildDraft()}><Text style={{ color: theme.color.brandPrimary, fontWeight: "700", marginTop: 8 }}>Update draft</Text></Pressable>
                    </View>
                  ) : null}

                  {(drafts.length ? drafts : [{ parsed, validation: validatedAction }]).map((draft, index, list) => {
                    const row = draft.parsed;
                    return (
                      <View key={`${row.intent}-${row.amount}-${index}`} style={{ marginTop: index ? 12 : 0 }}>
                        <Text style={[styles.draftLabel, { color: theme.color.brandPrimary }]}>Draft {list.length > 1 ? `${index + 1} of ${list.length} · ` : ""}{String(row.intent || "").replace("_", " ")}</Text>
                        <Text style={[styles.draftSummary, { color: theme.color.onSurface }]}>{row.summary}</Text>
                        <View style={styles.draftGrid}>
                          {row.pendingPartyCreate ? <Text style={{ color: theme.color.brandPrimary, marginBottom: 8 }}>Will create {row.pendingPartyCreate.role === "customer" ? "Customer" : "Supplier"} “{row.pendingPartyCreate.name}” on save.</Text> : null}
                          {row.amount != null && <DKV k="Amount" v={fmt(row.amount, bookCurrency)} theme={theme} />}
                          {row.date && <DKV k="Date" v={row.date} theme={theme} />}
                          {row.supplierName && <DKV k="Supplier" v={row.supplierName} theme={theme} />}
                          {row.customerName && <DKV k="Customer" v={row.customerName} theme={theme} />}
                          {row.partnerName && <DKV k="Capital Account" v={row.partnerName} theme={theme} />}
                          {row.paymentType && <DKV k="Type" v={row.paymentType} theme={theme} />}
                          {row.receiptMode && <DKV k="Receipt type" v={row.receiptMode === "against_invoice" ? "Against invoice" : row.receiptMode === "advance" ? "Customer advance" : "Cash sale"} theme={theme} />}
                          {row.method && <DKV k="Payment method" v={row.method === "upi" ? "mobile / UPI" : row.method} theme={theme} />}
                        </View>
                      </View>
                    );
                  })}

                  <View style={styles.btnRow}>
                    <Pressable onPress={reset} style={[styles.actionBtn, { backgroundColor: theme.color.surfaceTertiary }]}>
                      <Text style={[styles.actionText, { color: theme.color.onSurface }]}>Cancel</Text>
                    </Pressable>
                    <Pressable onPress={confirmSave} disabled={saving} style={[styles.actionBtn, { backgroundColor: theme.color.brandPrimary }]}>
                      {saving ? <ActivityIndicator color="#000" /> : <Text style={[styles.actionText, { color: '#000' }]}>{drafts.length > 1 ? `Save ${drafts.length}` : "Save"}</Text>}
                    </Pressable>
                  </View>
                </View>
              ) : phase === "error" ? (
                <View style={[styles.errorBox, { backgroundColor: (createProposal || pendingClarification) ? theme.color.surfaceTertiary : theme.color.errorBg, borderColor: (createProposal || pendingClarification) ? theme.color.brandPrimary + "55" : theme.color.error + "55" }]}>
                  <View style={styles.errorHeader}>
                    <Ionicons name={(createProposal || pendingClarification) ? "help-circle" : "alert-circle"} size={22} color={(createProposal || pendingClarification) ? theme.color.brandPrimary : theme.color.error} />
                    <Text style={[styles.errorText, { color: (createProposal || pendingClarification) ? theme.color.onSurface : theme.color.error }]}>{error}</Text>
                  </View>
                  {transcript ? <TextInput accessibilityLabel="Editable failed homepage voice transcript" value={transcript} onChangeText={setTranscript} multiline autoCorrect onSubmitEditing={Keyboard.dismiss} style={[styles.transcriptBubble, { color: theme.color.onSurface, backgroundColor: theme.color.surfaceTertiary, marginBottom: 0 }]} /> : null}
                  {createProposal ? (
                    <View style={styles.errorChoices}>
                      {(createProposal.suggestions || []).map((name) => (
                        <Pressable key={name} accessibilityRole="button" onPress={() => { setFollowUpAnswer(name); void continueDraft(name); }} style={[styles.actionBtn, styles.stackedBtn, { backgroundColor: theme.color.surfaceTertiary }]}>
                          <Text style={[styles.actionText, { color: theme.color.onSurface }]}>Use existing “{name}”</Text>
                        </Pressable>
                      ))}
                      <Pressable accessibilityRole="button" onPress={() => void continueDraft("supplier")} style={[styles.actionBtn, styles.stackedBtn, { backgroundColor: createProposal.suggestedRole === "customer" ? theme.color.surfaceTertiary : theme.color.brandPrimary }]}>
                        <Text style={[styles.actionText, { color: createProposal.suggestedRole === "customer" ? theme.color.onSurface : theme.color.onBrandPrimary }]}>Create Supplier{createProposal.name ? ` “${createProposal.name}”` : ""}</Text>
                      </Pressable>
                      <Pressable accessibilityRole="button" onPress={() => void continueDraft("customer")} style={[styles.actionBtn, styles.stackedBtn, { backgroundColor: createProposal.suggestedRole === "customer" ? theme.color.brandPrimary : theme.color.surfaceTertiary }]}>
                        <Text style={[styles.actionText, { color: createProposal.suggestedRole === "customer" ? theme.color.onBrandPrimary : theme.color.onSurface }]}>Create Customer{createProposal.name ? ` “${createProposal.name}”` : ""}</Text>
                      </Pressable>
                    </View>
                  ) : pendingClarification ? (
                    <View style={styles.errorChoices}>
                      <TextInput testID="voice-fab-clarification-answer" accessibilityLabel="Voice follow-up answer" value={followUpAnswer} onChangeText={setFollowUpAnswer} placeholder="Your answer" placeholderTextColor={theme.color.muted} onSubmitEditing={Keyboard.dismiss} style={[styles.transcriptBubble, { color: theme.color.onSurface, backgroundColor: theme.color.surfaceTertiary, marginBottom: 0 }]} />
                      <Pressable accessibilityRole="button" accessibilityLabel="Continue voice draft" disabled={!followUpAnswer.trim()} onPress={() => void continueDraft()} style={[styles.actionBtn, styles.stackedBtn, { backgroundColor: theme.color.brandPrimary, opacity: followUpAnswer.trim() ? 1 : 0.5 }]}>
                        <Text style={[styles.actionText, { color: theme.color.onBrandPrimary }]}>Continue draft</Text>
                      </Pressable>
                    </View>
                  ) : null}
                  <View style={styles.errorChoices}>
                    {transcript ? <Pressable accessibilityRole="button" accessibilityLabel="Update failed homepage voice draft" onPress={() => void rebuildDraft()} style={[styles.actionBtn, styles.stackedBtn, { backgroundColor: theme.color.surfaceTertiary }]}><Text style={[styles.actionText, { color: theme.color.brandPrimary }]}>Update draft</Text></Pressable> : null}
                    <Pressable accessibilityRole="button" accessibilityLabel="Try voice entry again" onPress={start} style={[styles.actionBtn, styles.stackedBtn, { backgroundColor: theme.color.brandPrimary }]}>
                      <Text style={[styles.actionText, { color: theme.color.onBrandPrimary }]}>Try Again</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </ScrollView>
          </Animated.View>
        </View>
      </Modal>
    </>
  );
}

function DKV({ k, v, theme }: { k: string; v: string; theme: any }) {
  return (
    <View style={{ width: "50%", paddingVertical: 4 }}>
      <Text style={{ fontSize: 11, color: theme.color.muted }}>{k}</Text>
      <Text style={{ fontSize: 14, color: theme.color.onSurface, fontWeight: "600" }}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    right: 20,
    bottom: 100, // Matching its original location
    width: 60,
    height: 60,
    borderRadius: 30,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
    zIndex: 110,
  },
  overlayContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
  },
  overlayPressable: {
    ...StyleSheet.absoluteFillObject,
  },
  popupContainer: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 500,
    padding: 24,
    paddingBottom: 24,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 24,
  },
  popupScroll: {
    flexShrink: 1,
  },
  popupScrollContent: {
    flexGrow: 0,
    paddingBottom: 4,
  },
  popupHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
  },
  popupTitle: {
    fontSize: 20,
    fontWeight: "700",
  },
  recordingBox: {
    alignItems: "center",
    paddingVertical: 24,
  },
  hintText: {
    fontSize: 14,
    marginBottom: 24,
    fontStyle: "italic",
    textAlign: "center",
  },
  bigMicBtn: {
    width: 96,
    height: 96,
    borderRadius: 48,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 12,
  },
  statusLabel: {
    marginTop: 24,
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  draftBox: {
    padding: 20,
    borderRadius: 24,
  },
  transcriptBubble: {
    padding: 12,
    borderRadius: 12,
    marginBottom: 16,
  },
  draftLabel: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  draftSummary: {
    fontSize: 18,
    fontWeight: "600",
    marginTop: 8,
    marginBottom: 16,
  },
  draftGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: 24,
  },
  btnRow: {
    flexDirection: "row",
    gap: 12,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: {
    fontWeight: "600",
    fontSize: 15,
  },
  errorBox: {
    padding: 20,
    borderRadius: 24,
    borderWidth: 1,
    alignItems: "stretch",
    gap: 12,
  },
  errorHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  errorChoices: {
    gap: 8,
  },
  errorText: {
    flex: 1,
    fontSize: 14,
    fontWeight: "500",
    lineHeight: 19,
  },
  stackedBtn: {
    flex: 0,
    alignSelf: "stretch",
  },
});

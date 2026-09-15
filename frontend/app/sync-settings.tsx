import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import QRCode from 'qrcode';
import { SvgXml } from 'react-native-svg';
import { api } from '@/src/api';
import { ScreenHeader } from '@/src/components/UI';
import { useTheme } from '@/src/context/ThemeContext';
import { activeBookId, activeSqlRunner } from '@/src/db/backend';
import { advanceSyncEpoch, createSyncEnrollmentCode, enrollSyncDevice, listSyncDevices, redeemSyncEnrollmentCode, revokeSyncDevice, type SyncDevice, type SyncEnrollmentCode } from '@/src/sync/recovery';
import { createSyncSetupQr, parseSyncSetupQr } from '@/src/sync/setupQr';
import { generateSyncPassphrase } from '@/src/sync/e2ee';
import { parseWifiP2pQr, type WifiP2pSession } from '@/src/sync/wifiP2pSync';
import { SETTINGS_SCREEN_CARD_GAP, SETTINGS_SCREEN_CONTENT_TOP, SETTINGS_SCREEN_HEADER_BOTTOM } from '@/src/utils/settingsScreenLayout';

type SyncModeTab = 'cloud' | 'wifi' | 'self_hosted';

const INVITE_ROLES: SyncEnrollmentCode['role'][] = ['viewer', 'accountant', 'editor', 'admin'];

export default function SyncSettingsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const [activeTab, setActiveTab] = useState<SyncModeTab>('cloud');

  // Cloud Drive State
  const [cloudEmail, setCloudEmail] = useState('');
  const [cloudPassphrase, setCloudPassphrase] = useState('');
  const [cloudAutoSync, setCloudAutoSync] = useState(true);
  const [cloudConfigSaved, setCloudConfigSaved] = useState(false);

  // Wi-Fi P2P State
  const [wifiSession, setWifiSession] = useState<WifiP2pSession | null>(null);
  const [wifiQrUri, setWifiQrUri] = useState<string | null>(null);
  const [wifiQrSvg, setWifiQrSvg] = useState('');
  const [inviteQrSvg, setInviteQrSvg] = useState('');
  const [wifiScanning, setWifiScanning] = useState(false);

  // Self-Hosted State (Existing)
  const [serverUrl, setServerUrl] = useState('');
  const [userId, setUserId] = useState('');
  const [token, setToken] = useState('');
  const [oidcIssuer, setOidcIssuer] = useState('');
  const [oidcClientId, setOidcClientId] = useState('');
  const [oidcScopes, setOidcScopes] = useState('openid profile offline_access');
  const [status, setStatus] = useState<any>(null);
  const [devices, setDevices] = useState<SyncDevice[]>([]);
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const [scanning, setScanning] = useState(false);
  const [scanLocked, setScanLocked] = useState(false);
  const [inviteRole, setInviteRole] = useState<SyncEnrollmentCode['role']>('viewer');
  const [selectedLocationIds, setSelectedLocationIds] = useState<string[]>([]);
  const [inviteQrValue, setInviteQrValue] = useState<string | null>(null);
  const [pendingEnrollmentCode, setPendingEnrollmentCode] = useState<string | null>(null);
  const [pendingEnrollmentBookId, setPendingEnrollmentBookId] = useState<string | null>(null);

  const scrollRef = useRef<ScrollView>(null);
  const [, requestCameraPermission] = useCameraPermissions();

  const load = useCallback(async () => {
    try {
      const next = await api.getSyncStatus();
      setStatus(next);
      if (next.serverUrl) setServerUrl((current) => current || next.serverUrl || '');
      if (next.userId) setUserId((current) => current || next.userId || '');
      if (next.oidcIssuer) setOidcIssuer((current) => current || next.oidcIssuer || '');
      if (next.oidcClientId) setOidcClientId((current) => current || next.oidcClientId || '');
      if (next.oidcScopes) setOidcScopes((current) => current || next.oidcScopes || '');

      const db = activeSqlRunner();
      setDevices(db && next.configured ? await listSyncDevices(db, activeBookId()).catch(() => []) : []);
      const localLocations = db && next.configured ? await api.listLocations().catch(() => []) : [];
      setLocations(localLocations.map((loc: any) => ({ id: String(loc.id), name: String(loc.name) })));
      setSelectedLocationIds((current) => current.filter((id) => localLocations.some((loc: any) => String(loc.id) === id)));

      // Load Cloud Drive configuration
      const cloudCfg = await api.getCloudSyncConfig();
      if (cloudCfg) {
        setCloudEmail(cloudCfg.accountEmail || '');
        setCloudPassphrase(cloudCfg.passphrase || '');
        setCloudAutoSync(cloudCfg.autoSyncEnabled ?? true);
        setCloudConfigSaved(!!cloudCfg.accountEmail);
      } else {
        setCloudPassphrase(generateSyncPassphrase());
      }

      // If user is already enrolled in self-hosting, open that tab
      if (next.configured) {
        setActiveTab('self_hosted');
      }
    } catch (error: any) {
      setMessage(error?.message || 'Sync is unavailable until SQLite is ready.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!wifiQrUri) {
      setWifiQrSvg('');
      return;
    }
    let active = true;
    QRCode.toString(wifiQrUri, {
      type: 'svg',
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((svg) => {
        if (active) setWifiQrSvg(svg);
      })
      .catch(() => {
        if (active) setWifiQrSvg('');
      });
    return () => {
      active = false;
    };
  }, [wifiQrUri]);

  // The invitation QR is rendered through qrcode + react-native-svg like the
  // Wi-Fi one above. It previously stayed on react-native-qrcode-svg, which is
  // no longer a dependency, so this panel crashed when it opened.
  useEffect(() => {
    if (!inviteQrValue) {
      setInviteQrSvg('');
      return;
    }
    let active = true;
    QRCode.toString(inviteQrValue, {
      type: 'svg',
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((svg) => {
        if (active) setInviteQrSvg(svg);
      })
      .catch(() => {
        if (active) setInviteQrSvg('');
      });
    return () => {
      active = false;
    };
  }, [inviteQrValue]);

  // Cloud Drive handlers
  const handleSaveCloudConfig = async () => {
    setBusy(true);
    setMessage('');
    try {
      await api.saveCloudSyncConfig({
        provider: 'google_drive',
        accountEmail: cloudEmail || 'user@example.com',
        passphrase: cloudPassphrase,
        autoSyncEnabled: cloudAutoSync,
      });
      setCloudConfigSaved(true);
      setMessage('Passphrase and Cloud Drive configuration saved locally. Google Drive transfer is not active until OAuth exists.');
    } catch (error: any) {
      setMessage(error?.message || 'Could not save Cloud Drive configuration.');
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateNewPassphrase = () => {
    Alert.alert(
      'Generate New Passphrase?',
      'Only devices with the matching passphrase can read this business account. Existing remote copies must also use this key.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Generate', onPress: () => setCloudPassphrase(generateSyncPassphrase()) },
      ]
    );
  };

  const adoptCloudKey = async () => {
    const passphrase = cloudPassphrase.trim();
    if (!passphrase) return;
    setBusy(true);
    setMessage('');
    try {
      const key = await api.adoptCloudSyncKey(passphrase);
      setMessage(key
        ? 'Joined the existing encrypted book. Pull to sync when you are ready.'
        : 'No encrypted book was found for that passphrase on this Drive account.');
    } catch (error: any) {
      setMessage(error?.message || 'Could not join with that passphrase.');
    } finally {
      setBusy(false);
    }
  };

  // Wi-Fi P2P handlers
  const handleStartWifiShare = async () => {
    setBusy(true);
    setMessage('');
    try {
      const { session, qrCodeUri } = api.createWifiP2pSession();
      setWifiSession(session);
      setWifiQrUri(qrCodeUri);
      setMessage('Wi-Fi pairing code created. Scan it on your receiving phone.');
    } catch (error: any) {
      setMessage(error?.message || 'Could not start Wi-Fi pairing session.');
    } finally {
      setBusy(false);
    }
  };

  const openWifiScanner = async () => {
    const permission = await requestCameraPermission();
    if (!permission.granted) {
      setMessage('Camera permission is required to scan Wi-Fi sync codes.');
      return;
    }
    setMessage('');
    setScanLocked(false);
    setWifiScanning(true);
  };

  const onWifiQrScanned = async (result: BarcodeScanningResult) => {
    if (scanLocked) return;
    setScanLocked(true);
    try {
      const parsed = parseWifiP2pQr(result.data);
      setWifiScanning(false);
      setMessage(`Wi-Fi pairing session detected from ${parsed.hostIp}.`);
      Alert.alert(
        'Pair Device Over Wi-Fi',
        `Pairing QR from ${parsed.hostIp} is valid. Nearby Wi-Fi book transfer is not available yet.`,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => setScanLocked(false) },
          {
            text: 'Synchronize',
            onPress: () => {
              setMessage('Nearby Wi-Fi book transfer is not available yet. Pairing QR is not a completed sync.');
            },
          },
        ]
      );
    } catch (error: any) {
      setScanLocked(false);
      setMessage(error?.message || 'Invalid Wi-Fi pairing QR code.');
    }
  };

  // Self-Hosted handlers (Existing)
  const completeEnrollment = async (db: ReturnType<typeof activeSqlRunner>) => {
    if (!db) throw new Error('Sync requires SQLite storage');
    const bookId = activeBookId();
    if (pendingEnrollmentBookId && pendingEnrollmentBookId !== bookId) {
      throw new Error('This invitation belongs to a different Business Account. Open the matching Business Account before enrolling.');
    }
    if (pendingEnrollmentCode) {
      const enrolled = await redeemSyncEnrollmentCode(db, bookId, pendingEnrollmentCode, undefined, Platform.OS);
      setPendingEnrollmentCode(null);
      setPendingEnrollmentBookId(null);
      return enrolled;
    }
    return enrollSyncDevice(db, bookId);
  };

  const createInvitationQr = async () => {
    setBusy(true);
    setMessage('');
    try {
      if (!status?.configured || !status.bookEpoch) throw new Error('Enroll this phone before creating an invitation');
      const db = activeSqlRunner();
      if (!db) throw new Error('Sync requires SQLite storage');
      const invitation = await createSyncEnrollmentCode(db, activeBookId(), inviteRole, selectedLocationIds, 15);
      const value = createSyncSetupQr({
        serverUrl,
        oidcIssuer,
        oidcClientId,
        oidcScopes,
        bookId: invitation.bookId,
        enrollmentCode: invitation.code,
        enrollmentRole: invitation.role,
        locationIds: invitation.locationIds,
        expiresAt: invitation.expiresAt,
      });
      setInviteQrValue(value);
      setMessage(`Invitation created for ${invitation.role}. It expires at ${new Date(invitation.expiresAt).toLocaleTimeString()}.`);
    } catch (error: any) {
      setMessage(error?.message || 'Could not create an invitation QR code.');
    } finally {
      setBusy(false);
    }
  };

  const enroll = async () => {
    setBusy(true);
    setMessage('');
    try {
      await api.configureSync({ serverUrl, userId, accessToken: token, enabled: false, oidcIssuer, oidcClientId, oidcScopes });
      const db = activeSqlRunner();
      if (!db) throw new Error('Sync requires SQLite storage');
      const enrolled = await completeEnrollment(db);
      setToken('');
      const next = await api.getSyncStatus();
      setStatus(next);
      setMessage(
        next.bootstrapRequired
          ? 'Device enrolled against an empty server epoch. Review destination, then publish snapshot.'
          : next.recoveryRequired
          ? `Device enrolled in epoch ${enrolled.epochNumber}. Export backup, then install validated snapshot.`
          : 'Device enrolled. Local writes remain available offline.'
      );
      await load();
    } catch (error: any) {
      setMessage(error?.message || 'Could not enroll this device.');
    } finally {
      setBusy(false);
    }
  };

  const enrollOidc = async () => {
    setBusy(true);
    setMessage('');
    try {
      await api.authorizeSyncOidc({ serverUrl, userId, oidcIssuer, oidcClientId, oidcScopes });
      const db = activeSqlRunner();
      if (!db) throw new Error('Sync requires SQLite storage');
      const enrolled = await completeEnrollment(db);
      const next = await api.getSyncStatus();
      setStatus(next);
      setMessage(
        next.bootstrapRequired
          ? 'OIDC sign-in succeeded. Server epoch is empty; publish initial snapshot.'
          : next.recoveryRequired
          ? `OIDC sign-in succeeded for epoch ${enrolled.epochNumber}. Export backup, then install server snapshot.`
          : 'OIDC sign-in and device enrollment completed. Local writes remain available offline.'
      );
      await load();
    } catch (error: any) {
      setMessage(error?.message || 'Could not sign in and enroll this device.');
    } finally {
      setBusy(false);
    }
  };

  const sync = async () => {
    setBusy(true);
    setMessage('');
    try {
      setStatus(await api.syncNow());
      setMessage('Sync completed.');
      await load();
    } catch (error: any) {
      setMessage(error?.message || 'Sync could not reach the server; local data is unchanged.');
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    setBusy(true);
    setMessage('');
    try {
      setStatus(await api.retrySyncNow());
      setMessage('Retry completed.');
      await load();
    } catch (error: any) {
      setMessage(error?.message || 'Retry could not reach the server; local data is unchanged.');
    } finally {
      setBusy(false);
    }
  };

  const advanceEpoch = () =>
    Alert.alert(
      'Advance server epoch?',
      'Use this only when reset, restore, or deletion intentionally replaces the shared Business Account. All devices will be revoked and must re-enroll.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Advance epoch',
          style: 'destructive',
          onPress: async () => {
            const db = activeSqlRunner();
            if (!db) return;
            setBusy(true);
            try {
              await advanceSyncEpoch(db, activeBookId(), status?.recoveryReason || 'Explicit recovery');
              setMessage('Server epoch advanced. Re-enroll this device, sync empty epoch, then publish snapshot.');
              await load();
            } catch (error: any) {
              setMessage(error?.message || 'Could not advance the server epoch.');
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );

  const installSnapshot = async () => {
    setBusy(true);
    setMessage('');
    try {
      const fn = (api as any).installSyncSnapshot;
      if (typeof fn !== 'function') throw new Error('Snapshot installer is not registered in this build');
      await fn();
      setMessage('Validated snapshot installed, canonical events caught up, and preserved local work replayed atomically.');
      await load();
    } catch (error: any) {
      setMessage(error?.message || 'Snapshot recovery failed; local data was rolled back.');
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    setBusy(true);
    setMessage('');
    try {
      await api.publishSyncSnapshot();
      setMessage('Recovery snapshot published for this canonical checkpoint.');
      await load();
    } catch (error: any) {
      setMessage(error?.message || 'Could not publish the recovery snapshot.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setMessage('');
    try {
      const result = await api.verifySyncCheckpoint();
      setMessage(result.eventHashMatches && result.projectionHashMatches !== false ? 'Checkpoint verified.' : 'Checkpoint mismatch detected; recovery is required.');
      await load();
    } catch (error: any) {
      setMessage(error?.message || 'Checkpoint verification failed.');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      await api.disableSync();
      setMessage('Sync disabled. Pending local work is retained.');
      await load();
    } catch (error: any) {
      setMessage(error?.message || 'Could not disable sync.');
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    setBusy(true);
    try {
      await api.enableSync();
      setMessage('Sync enabled. Local writes remain offline-first.');
      await load();
    } catch (error: any) {
      setMessage(error?.message || 'Could not enable sync.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = (device: SyncDevice) =>
    Alert.alert(
      'Revoke device?',
      device.current ? 'This device will stop syncing and must be explicitly re-enrolled.' : `Device ${device.deviceId.slice(0, 12)}… will no longer access this Business Account.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: async () => {
            const db = activeSqlRunner();
            if (!db) return;
            setBusy(true);
            try {
              await revokeSyncDevice(db, activeBookId(), device.deviceId);
              setMessage('Device revoked.');
              await load();
            } catch (error: any) {
              setMessage(error?.message || 'Could not revoke device.');
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );

  const openSetupScanner = async () => {
    const permission = await requestCameraPermission();
    if (!permission.granted) {
      setMessage('Camera permission is required to scan a Ledgr setup QR code.');
      return;
    }
    setMessage('');
    setScanLocked(false);
    setScanning(true);
  };

  const openSelfHostPackage = async () => {
    router.push('/self-host-guide' as any);
  };

  const scrollToEnrollmentControls = () => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 120);
  };

  const onSetupQr = (result: BarcodeScanningResult) => {
    if (scanLocked) return;
    setScanLocked(true);
    try {
      const setup = parseSyncSetupQr(result.data);
      setServerUrl(setup.serverUrl);
      setOidcIssuer(setup.oidcIssuer);
      setOidcClientId(setup.oidcClientId);
      if (setup.oidcScopes) setOidcScopes(setup.oidcScopes);
      setPendingEnrollmentCode(setup.enrollmentCode || null);
      setPendingEnrollmentBookId(setup.bookId || null);
      setScanning(false);
      setMessage(
        setup.enrollmentCode
          ? `Invitation imported for ${setup.enrollmentRole || 'member'}. Review connection details, then sign in with OIDC.`
          : 'Setup details imported. Review them, then sign in with OIDC and enroll.'
      );
    } catch (error: any) {
      setScanLocked(false);
      setMessage(error?.message || 'That QR code is not a valid Ledgr setup code.');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={[styles.header, { paddingBottom: SETTINGS_SCREEN_HEADER_BOTTOM }]}>
        <Pressable onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color={theme.color.onSurface} />
        </Pressable>
        <ScreenHeader embedded title="Multi-Device Sync" subtitle="Keep your accounts in sync securely" titleStyle={styles.headerTitle} />
      </View>

      <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={[styles.scroll, { paddingTop: SETTINGS_SCREEN_CONTENT_TOP, gap: SETTINGS_SCREEN_CARD_GAP }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {/* Top Segmented Tab Switcher */}
          <View style={styles.tabBar}>
            <Pressable testID="sync-tab-cloud" onPress={() => setActiveTab('cloud')} style={[styles.tabItem, activeTab === 'cloud' && styles.tabItemActive]}>
              <Ionicons name="logo-google" size={16} color={activeTab === 'cloud' ? theme.color.brandPrimary : theme.color.muted} />
              <Text style={[styles.tabText, activeTab === 'cloud' && styles.tabTextActive]}>Google Drive</Text>
            </Pressable>
            <Pressable testID="sync-tab-wifi" onPress={() => setActiveTab('wifi')} style={[styles.tabItem, activeTab === 'wifi' && styles.tabItemActive]}>
              <Ionicons name="wifi-outline" size={16} color={activeTab === 'wifi' ? theme.color.brandPrimary : theme.color.muted} />
              <Text style={[styles.tabText, activeTab === 'wifi' && styles.tabTextActive]}>Nearby Wi-Fi</Text>
            </Pressable>
            <Pressable testID="sync-tab-self-hosted" onPress={() => setActiveTab('self_hosted')} style={[styles.tabItem, activeTab === 'self_hosted' && styles.tabItemActive]}>
              <Ionicons name="server-outline" size={16} color={activeTab === 'self_hosted' ? theme.color.brandPrimary : theme.color.muted} />
              <Text style={[styles.tabText, activeTab === 'self_hosted' && styles.tabTextActive]}>Self-Hosted</Text>
            </Pressable>
          </View>

          {/* TAB 1: GOOGLE DRIVE SYNC (E2EE) */}
          {activeTab === 'cloud' && (
            <View style={styles.card}>
              <View style={styles.badgeRow}>
                <Ionicons name="shield-checkmark" size={18} color={theme.color.brandPrimary} />
                <Text style={styles.badgeText}>AES-256-GCM Zero-Knowledge Encryption</Text>
              </View>
              <Text style={styles.title}>Google Drive Sync & Backup</Text>
              <Text style={styles.hint}>
                Sync seamlessly across your devices and keep an automatic encrypted backup in your private Google Drive app folder. All ledger numbers are end-to-end encrypted on this phone before uploading. Google cannot read your financial records.
              </Text>

              <Text style={styles.label}>Google Account</Text>
              <TextInput
                value={cloudEmail}
                onChangeText={setCloudEmail}
                autoCapitalize="none"
                keyboardType="email-address"
                placeholder="you@gmail.com"
                placeholderTextColor={theme.color.muted}
                style={styles.input}
              />

              <View style={styles.passphraseHeader}>
                <Text style={styles.label}>Secret Sync Passphrase</Text>
                <Pressable testID="cloud-generate-passphrase" onPress={handleGenerateNewPassphrase}>
                  <Text style={styles.inlineAction}>Generate New</Text>
                </Pressable>
              </View>
              <TextInput
                value={cloudPassphrase}
                testID="cloud-passphrase"
                onChangeText={setCloudPassphrase}
                autoCapitalize="none"
                placeholder="24-character security key"
                placeholderTextColor={theme.color.muted}
                style={styles.input}
              />
              <Text style={styles.subHint}>
                Keep this passphrase safe! You must enter this same passphrase on your other devices to decrypt this business account. It is the only thing that unlocks the backup, and nobody can recover it for you.
              </Text>

              <Pressable disabled={busy || !cloudPassphrase.trim()} onPress={handleSaveCloudConfig} style={[styles.primary, (busy || !cloudPassphrase.trim()) && styles.disabled]}>
                <Text style={styles.primaryText}>{busy ? 'Saving...' : cloudConfigSaved ? 'Update saved configuration' : 'Save passphrase locally'}</Text>
              </Pressable>

              <Pressable
                testID="cloud-join"
                accessibilityRole="button"
                accessibilityLabel="Join this book with the passphrase"
                disabled={busy || !cloudPassphrase.trim()}
                onPress={adoptCloudKey}
                style={[styles.secondary, (busy || !cloudPassphrase.trim()) && styles.disabled]}
              >
                <Text style={styles.secondaryText}>This is my second phone - join with the passphrase</Text>
              </Pressable>
            </View>
          )}

          {/* TAB 2: NEARBY WI-FI P2P SYNC */}
          {activeTab === 'wifi' && (
            <View style={styles.card}>
              <View style={styles.badgeRow}>
                <Ionicons name="flash-outline" size={18} color={theme.color.brandPrimary} />
                <Text style={styles.badgeText}>Direct Local Wi-Fi (No Cloud Needed)</Text>
              </View>
              <Text style={styles.title}>Nearby Phone Sync</Text>
              <Text style={styles.hint}>
                Transfer or sync directly between two phones on the same home or office Wi-Fi network. Works with no internet at all, so it suits a market stall or a warehouse. Instant, and zero setup required.
              </Text>

              <View style={styles.actionBlock}>
                <Text style={styles.packageTitle}>1. Share to another phone</Text>
                <Text style={styles.packageHint}>Show a secure QR code on this screen. Your second phone can scan it to import this account.</Text>
                <Pressable disabled={busy} testID="wifi-create-session" onPress={handleStartWifiShare} style={[styles.secondaryButtonRow, busy && styles.disabled]}>
                  <Ionicons name="qr-code-outline" size={20} color={theme.color.brandPrimary} />
                  <Text style={styles.secondaryButtonText}>{busy ? 'Preparing QR...' : 'Create Pairing QR Code'}</Text>
                </Pressable>

                {wifiQrUri && (
                  <View style={styles.qrPreview}>
                    <Text style={styles.qrTitle}>Scan on Receiving Phone</Text>
                    {wifiSession?.sessionId ? <Text style={styles.mono}>Session: {wifiSession.sessionId}</Text> : null}
                    <Text style={styles.qrHint}>Expires in 15 minutes. Data is transferred directly over Wi-Fi with end-to-end encryption.</Text>
                    <View style={styles.qrSurface}>
                      {wifiQrSvg ? <SvgXml xml={wifiQrSvg} width={220} height={220} /> : <ActivityIndicator color={theme.color.brandPrimary} />}
                    </View>
                    <Pressable onPress={() => setWifiQrUri(null)} style={styles.closeQr}>
                      <Text style={styles.closeScannerText}>Done / Close QR</Text>
                    </Pressable>
                  </View>
                )}
              </View>

              <View style={styles.actionBlock}>
                <Text style={styles.packageTitle}>2. Receive from another phone</Text>
                <Text style={styles.packageHint}>Scan the pairing QR code displayed on your other phone to import the account data.</Text>
                <Pressable onPress={openWifiScanner} style={styles.scanButton}>
                  <Ionicons name="camera-outline" size={20} color={theme.color.brandPrimary} />
                  <Text style={styles.scanButtonText}>Scan Pairing QR Code</Text>
                </Pressable>

                {wifiScanning && (
                  <View style={styles.scanner}>
                    <CameraView style={styles.camera} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={scanLocked ? undefined : onWifiQrScanned} />
                    <View style={styles.scannerOverlay}>
                      <Text style={styles.scannerText}>Align the Wi-Fi pairing QR inside the frame</Text>
                      <Pressable onPress={() => setWifiScanning(false)} style={styles.closeScanner}>
                        <Text style={styles.closeScannerText}>Close Scanner</Text>
                      </Pressable>
                    </View>
                  </View>
                )}
              </View>
            </View>
          )}

          {/* TAB 3: SELF-HOSTED SERVER (EXISTING COMPONENT) */}
          {activeTab === 'self_hosted' && (
            <>
              <View style={styles.card}>
                <Text style={styles.title}>Your device stays local first</Text>
                <Text style={styles.hint}>
                  Writes commit locally immediately. Enrollment obtains the Business Account epoch from your server; recovery never merges raw SQLite files.
                </Text>

                <Pressable testID="download-self-host-package" onPress={openSelfHostPackage} style={styles.packageButton}>
                  <Ionicons name="download-outline" size={20} color={theme.color.brandPrimary} />
                  <View style={styles.packageCopy}>
                    <Text style={styles.packageTitle}>Download Self-host Package</Text>
                    <Text style={styles.packageHint}>Windows, macOS, Linux, and Docker bundle</Text>
                  </View>
                  <Ionicons name="open-outline" size={18} color={theme.color.muted} />
                </Pressable>

                {status?.configured ? (
                  <View style={styles.invitePanel}>
                    <Text style={styles.packageTitle}>Create invitation QR for another phone</Text>
                    <Text style={styles.packageHint}>Choose access, then show a one-time QR. The recipient signs in with their own account.</Text>
                    <Text style={styles.inviteLabel}>Access level</Text>
                    <View style={styles.chipRow}>
                      {INVITE_ROLES.map((role) => (
                        <Pressable key={role} onPress={() => setInviteRole(role)} style={[styles.chip, inviteRole === role && styles.chipSelected]}>
                          <Text style={[styles.chipText, inviteRole === role && styles.chipTextSelected]}>{role}</Text>
                        </Pressable>
                      ))}
                    </View>
                    {locations.length ? (
                      <>
                        <Text style={styles.inviteLabel}>Locations (optional)</Text>
                        <View style={styles.chipRow}>
                          {locations.map((loc) => {
                            const selected = selectedLocationIds.includes(loc.id);
                            return (
                              <Pressable
                                key={loc.id}
                                onPress={() => setSelectedLocationIds((current) => (selected ? current.filter((id) => id !== loc.id) : [...current, loc.id]))}
                                style={[styles.chip, selected && styles.chipSelected]}
                              >
                                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{loc.name}</Text>
                              </Pressable>
                            );
                          })}
                        </View>
                        <Text style={styles.packageHint}>{selectedLocationIds.length ? 'Only selected locations will be available.' : 'No locations selected: all locations will be available.'}</Text>
                      </>
                    ) : null}
                    <Pressable testID="create-sync-invitation-qr" disabled={busy} onPress={createInvitationQr} style={[styles.qrButton, busy && styles.disabled]}>
                      <Ionicons name="qr-code-outline" size={20} color={theme.color.brandPrimary} />
                      <View style={styles.packageCopy}>
                        <Text style={styles.packageTitle}>{busy ? 'Creating invitation…' : 'Create invitation QR'}</Text>
                        <Text style={styles.packageHint}>Expires in 15 minutes and can be used once</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={18} color={theme.color.muted} />
                    </Pressable>
                  </View>
                ) : null}

                {inviteQrValue ? (
                  <View style={styles.qrPreview}>
                    <Text style={styles.qrTitle}>Scan this invitation on the joining phone</Text>
                    <Text style={styles.qrHint}>This QR contains connection details and a one-time invitation code only. It does not contain an access token or password.</Text>
                    <View style={styles.qrSurface}>
                      {inviteQrSvg ? <SvgXml xml={inviteQrSvg} width={220} height={220} /> : <ActivityIndicator color={theme.color.brandPrimary} />}
                    </View>
                    <Pressable onPress={() => setInviteQrValue(null)} style={styles.closeQr}>
                      <Text style={styles.closeScannerText}>Close QR</Text>
                    </Pressable>
                  </View>
                ) : null}

                <Pressable testID="scan-sync-setup" onPress={openSetupScanner} style={styles.scanButton}>
                  <Ionicons name="qr-code-outline" size={20} color={theme.color.brandPrimary} />
                  <Text style={styles.scanButtonText}>{pendingEnrollmentCode ? 'Invitation scanned — review and enroll' : 'Scan setup QR'}</Text>
                </Pressable>

                {scanning ? (
                  <View style={styles.scanner}>
                    <CameraView style={styles.camera} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={scanLocked ? undefined : onSetupQr} />
                    <View style={styles.scannerOverlay}>
                      <Text style={styles.scannerText}>Align the Ledgr setup QR code inside the frame</Text>
                      <Pressable onPress={() => setScanning(false)} style={styles.closeScanner}>
                        <Text style={styles.closeScannerText}>Close scanner</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}

                <Text style={styles.label}>Server URL</Text>
                <TextInput value={serverUrl} onChangeText={setServerUrl} autoCapitalize="none" keyboardType="url" placeholder="https://sync.example.com" placeholderTextColor={theme.color.muted} style={styles.input} />

                <Text style={styles.label}>Account or user ID</Text>
                <TextInput value={userId} onChangeText={setUserId} autoCapitalize="none" placeholder="you@example.com" placeholderTextColor={theme.color.muted} style={styles.input} />

                <Text style={styles.label}>OIDC issuer</Text>
                <TextInput value={oidcIssuer} onChangeText={setOidcIssuer} autoCapitalize="none" keyboardType="url" placeholder="https://identity.example.com/realms/ledgr" placeholderTextColor={theme.color.muted} style={styles.input} />

                <Text style={styles.label}>OIDC client ID</Text>
                <TextInput value={oidcClientId} onChangeText={setOidcClientId} autoCapitalize="none" placeholder="ledgr-mobile" placeholderTextColor={theme.color.muted} style={styles.input} />

                <Text style={styles.label}>OIDC scopes</Text>
                <TextInput value={oidcScopes} onChangeText={setOidcScopes} autoCapitalize="none" placeholder="openid profile offline_access" placeholderTextColor={theme.color.muted} style={styles.input} />

                <Pressable disabled={busy || !serverUrl.trim() || !userId.trim() || !oidcIssuer.trim() || !oidcClientId.trim()} onPress={enrollOidc} style={[styles.primary, (busy || !serverUrl.trim() || !userId.trim() || !oidcIssuer.trim() || !oidcClientId.trim()) && styles.disabled]}>
                  <Text style={styles.primaryText}>{busy ? 'Working…' : 'Sign in with OIDC and enroll'}</Text>
                </Pressable>

                <Text style={styles.hint}>The app uses Authorization Code + PKCE and securely rotates refresh tokens. Configure the redirect URI ledgr://sync-oidc in your identity provider.</Text>

                <Text style={styles.label}>Manual access token (development fallback)</Text>
                <TextInput value={token} onChangeText={setToken} onFocus={scrollToEnrollmentControls} autoCapitalize="none" secureTextEntry placeholder="Stored only in SecureStore" placeholderTextColor={theme.color.muted} style={styles.input} />

                <Pressable disabled={busy || !serverUrl.trim() || !userId.trim() || !token.trim()} onPress={enroll} style={[styles.secondary, (busy || !serverUrl.trim() || !userId.trim() || !token.trim()) && styles.disabled]}>
                  <Text style={styles.secondaryText}>{status?.configured ? 'Update token and re-enroll' : 'Enroll with manual token'}</Text>
                </Pressable>

                {status?.configured ? (
                  <View style={styles.status}>
                    <Text style={styles.statusTitle}>{status.bootstrapRequired ? 'Bootstrap snapshot required' : status.recoveryRequired ? 'Recovery required' : status.enabled ? 'Sync enabled' : 'Sync disabled'}</Text>
                    <Text style={styles.hint}>{status.pending} pending · {status.conflicts} conflicts · cursor {status.cursor ?? 0}</Text>
                    {status.bookEpoch ? <Text style={styles.mono}>Epoch {status.bookEpoch}</Text> : null}
                    {status.lastSyncAt ? <Text style={styles.hint}>Last successful sync {new Date(status.lastSyncAt).toLocaleString()}</Text> : null}
                    {status.lastVerifiedAt ? <Text style={styles.hint}>Checkpoint verified {new Date(status.lastVerifiedAt).toLocaleString()}</Text> : null}
                    {status.lastError ? <Text style={styles.error}>{status.lastError}</Text> : null}
                    <View style={styles.row}>
                      <Pressable disabled={busy || !status.enabled} onPress={sync} style={styles.secondary}><Text style={styles.secondaryText}>Sync now</Text></Pressable>
                      <Pressable disabled={busy || !status.enabled || !status.retryable} onPress={retry} style={styles.secondary}><Text style={styles.secondaryText}>Retry now</Text></Pressable>
                      <Pressable disabled={busy || !status.enabled} onPress={verify} style={styles.secondary}><Text style={styles.secondaryText}>Verify</Text></Pressable>
                      <Pressable disabled={busy || (!status.enabled && !status.bootstrapRequired)} onPress={publish} style={styles.secondary}><Text style={styles.secondaryText}>{status.bootstrapRequired ? 'Publish initial snapshot' : 'Publish snapshot'}</Text></Pressable>
                      {status.recoveryRequired && !status.bootstrapRequired ? (
                        <>
                          <Pressable disabled={busy} onPress={() => router.push('/advanced-settings' as any)} style={styles.secondary}><Text style={styles.secondaryText}>Export backup first</Text></Pressable>
                          <Pressable disabled={busy} onPress={installSnapshot} style={styles.secondary}><Text style={styles.secondaryText}>Restore server snapshot</Text></Pressable>
                          <Pressable disabled={busy} onPress={advanceEpoch} style={styles.secondary}><Text style={styles.secondaryText}>Replace shared epoch</Text></Pressable>
                        </>
                      ) : null}
                      {!status.enabled && !status.recoveryRequired ? (
                        <Pressable disabled={busy} onPress={enable} style={styles.secondary}><Text style={styles.secondaryText}>Enable</Text></Pressable>
                      ) : (
                        <Pressable disabled={busy || !status.enabled} onPress={disable} style={styles.secondary}><Text style={styles.secondaryText}>Disable</Text></Pressable>
                      )}
                    </View>
                  </View>
                ) : null}
              </View>

              {status?.configured ? (
                <View style={styles.card}>
                  <Text style={styles.title}>Enrolled devices</Text>
                  <Text style={styles.hint}>Revocation and enrollment expiry are enforced by the server. Revoking this device also clears its local credentials.</Text>
                  {devices.length ? (
                    devices.map((device) => (
                      <View key={device.deviceId} style={styles.device}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.deviceTitle}>{device.current ? 'This device' : `Device ${device.deviceId.slice(0, 12)}…`}</Text>
                          <Text style={styles.hint}>
                            {device.revokedAt ? 'Revoked' : device.lastSeenAt ? `Last seen ${new Date(device.lastSeenAt).toLocaleString()}` : 'Enrolled'}
                            {device.expiresAt && !device.revokedAt ? ` · expires ${new Date(device.expiresAt).toLocaleDateString()}` : ''}
                          </Text>
                        </View>
                        {!device.revokedAt ? (
                          <Pressable disabled={busy} onPress={() => revoke(device)} style={styles.revoke}><Text style={styles.revokeText}>Revoke</Text></Pressable>
                        ) : null}
                      </View>
                    ))
                  ) : (
                    <Text style={styles.hint}>Device list is unavailable or empty.</Text>
                  )}
                </View>
              ) : null}
            </>
          )}

          {message ? <Text style={styles.message}>{message}</Text> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const makeStyles = (theme: any) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    keyboard: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: theme.spacing.lg, paddingTop: 16 },
    headerTitle: { fontSize: 23, lineHeight: 29 },
    scroll: { padding: theme.spacing.lg, paddingBottom: 160, gap: 14 },
    tabBar: { flexDirection: 'row', backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, padding: 4, borderWidth: 1, borderColor: theme.color.border },
    tabItem: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: theme.radius.sm },
    tabItemActive: { backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1 },
    tabText: { color: theme.color.muted, fontSize: 13, fontWeight: '600' },
    tabTextActive: { color: theme.color.onSurface, fontWeight: '700' },
    card: { backgroundColor: theme.color.surfaceSecondary, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.lg, padding: 18, gap: 8 },
    title: { color: theme.color.onSurface, fontSize: 18, fontWeight: '700' },
    hint: { color: theme.color.muted, fontSize: 13, lineHeight: 19 },
    subHint: { color: theme.color.muted, fontSize: 12, lineHeight: 16, marginTop: 4 },
    mono: { color: theme.color.muted, fontSize: 11 },
    badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 4 },
    badgeText: { color: theme.color.brandPrimary, fontSize: 12, fontWeight: '700' },
    actionBlock: { borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, padding: 14, marginTop: 8, gap: 8 },
    passphraseHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 },
    inlineAction: { color: theme.color.brandPrimary, fontSize: 12, fontWeight: '700' },
    label: { color: theme.color.onSurface, fontSize: 13, fontWeight: '600', marginTop: 12 },
    input: { color: theme.color.onSurface, backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, paddingHorizontal: 12, paddingVertical: 11 },
    primary: { backgroundColor: theme.color.brandPrimary, borderRadius: theme.radius.md, paddingVertical: 13, alignItems: 'center', marginTop: 16 },
    primaryText: { color: theme.color.onBrandPrimary, fontWeight: '700' },
    disabled: { opacity: 0.45 },
    packageButton: { flexDirection: 'row', alignItems: 'center', gap: 10, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, padding: 12, marginTop: 8 },
    packageCopy: { flex: 1, gap: 2 },
    packageTitle: { color: theme.color.onSurface, fontWeight: '700' },
    packageHint: { color: theme.color.muted, fontSize: 12 },
    invitePanel: { borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, padding: 12, marginTop: 8, gap: 6 },
    inviteLabel: { color: theme.color.onSurface, fontWeight: '700', marginTop: 8 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: { borderColor: theme.color.border, borderWidth: 1, borderRadius: 18, paddingHorizontal: 11, paddingVertical: 8 },
    chipSelected: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.surface },
    chipText: { color: theme.color.muted, fontSize: 12, fontWeight: '600' },
    chipTextSelected: { color: theme.color.brandPrimary },
    qrButton: { flexDirection: 'row', alignItems: 'center', gap: 10, borderColor: theme.color.brandPrimary, borderWidth: 1, borderRadius: theme.radius.md, padding: 12, marginTop: 8 },
    qrPreview: { alignItems: 'center', gap: 8, borderTopColor: theme.color.border, borderTopWidth: 1, marginTop: 8, paddingTop: 16 },
    qrTitle: { color: theme.color.onSurface, fontWeight: '700', textAlign: 'center' },
    qrHint: { color: theme.color.muted, fontSize: 12, lineHeight: 18, textAlign: 'center' },
    qrSurface: { padding: 14, backgroundColor: '#fff', borderRadius: theme.radius.md, marginVertical: 6 },
    closeQr: { backgroundColor: theme.color.brandPrimary, borderRadius: theme.radius.md, paddingHorizontal: 16, paddingVertical: 10 },
    scanButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderColor: theme.color.brandPrimary, borderWidth: 1, borderRadius: theme.radius.md, paddingVertical: 12, marginTop: 6 },
    scanButtonText: { color: theme.color.brandPrimary, fontWeight: '700' },
    secondaryButtonRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, paddingVertical: 12, marginTop: 6 },
    secondaryButtonText: { color: theme.color.onSurface, fontWeight: '700' },
    scanner: { height: 300, overflow: 'hidden', borderRadius: theme.radius.md, backgroundColor: '#000', marginTop: 8 },
    camera: { flex: 1 },
    scannerOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end', alignItems: 'center', padding: 16, backgroundColor: 'transparent' },
    scannerText: { color: '#fff', textAlign: 'center', fontWeight: '700', textShadowColor: '#000', textShadowRadius: 4 },
    closeScanner: { backgroundColor: theme.color.brandPrimary, borderRadius: theme.radius.md, paddingHorizontal: 16, paddingVertical: 10, marginTop: 10 },
    closeScannerText: { color: theme.color.onBrandPrimary, fontWeight: '700' },
    status: { borderTopColor: theme.color.border, borderTopWidth: 1, marginTop: 18, paddingTop: 14, gap: 6 },
    statusTitle: { color: theme.color.brandPrimary, fontWeight: '700' },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 },
    secondary: { borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, paddingHorizontal: 14, paddingVertical: 10 },
    secondaryText: { color: theme.color.onSurface, fontWeight: '600' },
    error: { color: theme.color.danger || '#c53b3b', fontSize: 12 },
    message: { color: theme.color.muted, fontSize: 13, marginTop: 8 },
    device: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: theme.color.border, paddingTop: 12, marginTop: 8 },
    deviceTitle: { color: theme.color.onSurface, fontWeight: '600' },
    revoke: { padding: 10 },
    revokeText: { color: theme.color.danger || '#c53b3b', fontWeight: '700' },
  });

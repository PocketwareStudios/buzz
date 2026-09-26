import 'package:flutter/widgets.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:nostr/nostr.dart' as nostr;

import '../../../shared/community/community_provider.dart';
import '../../../shared/relay/relay.dart';
import '../../../shared/theme/theme_provider.dart';
import 'channel_flag_manager.dart';
import 'channel_flag_store.dart';

class ChannelFlagState<S> {
  final bool isReady;
  final S store;

  /// Bumped on every change to force downstream rebuilds.
  final int version;

  const ChannelFlagState({
    required this.isReady,
    required this.store,
    required this.version,
  });
}

/// Owns one flag's [ChannelFlagManager] for the active identity and relay
/// session, and republishes its store as state.
abstract class ChannelFlagNotifier<
  E extends ChannelFlagEntry,
  S extends ChannelFlagStore<E>,
  St extends ChannelFlagState<S>
>
    extends Notifier<St> {
  ChannelFlagManager<E, S>? _manager;

  ChannelFlagSpec<E, S> get spec;

  /// State before an identity is available.
  St get emptyState;

  St stateFor({required bool isReady, required S store, required int version});

  @override
  St build() {
    _manager?.dispose(flushPending: false);
    _manager = null;

    final relayConfig = ref.watch(relayConfigProvider);
    final sessionState = ref.watch(relaySessionProvider);
    // Rebuild when the active community changes (pubkey may differ).
    ref.watch(activeCommunityProvider);

    final nsec = relayConfig.nsec?.trim();
    if (nsec == null || nsec.isEmpty) {
      return emptyState;
    }

    final pubkey = _safePubkeyFromNsec(nsec);
    if (pubkey == null || pubkey.isEmpty) {
      return emptyState;
    }

    final ChannelFlagCrypto crypto;
    try {
      crypto = ChannelFlagCrypto(nsec, pubkey);
    } catch (_) {
      return emptyState;
    }

    final prefs = ref.read(savedPrefsProvider);
    final signedRelay = SignedEventRelay(
      session: ref.read(relaySessionProvider.notifier),
      nsec: nsec,
    );

    late final ChannelFlagManager<E, S> manager;
    manager = ChannelFlagManager<E, S>(
      spec: spec,
      pubkey: pubkey,
      prefs: prefs,
      crypto: crypto,
      relaySession: ref.read(relaySessionProvider.notifier),
      signedEventRelay: signedRelay,
      remoteEnabled: sessionState.status == SessionStatus.connected,
      onChanged: () => _emitManagerState(manager),
    );
    _manager = manager;

    // Resume re-read catches an EVENT a healthy socket never delivered.
    ref.listen(appLifecycleProvider, (_, next) {
      if (next == AppLifecycleState.resumed) manager.refreshFromRelay();
    });

    ref.onDispose(() {
      manager.dispose();
      if (_manager == manager) {
        _manager = null;
      }
    });

    Future.microtask(() async {
      await manager.initialize();
      if (_manager != manager) return;
      _emitManagerState(manager);
    });

    return stateFor(isReady: false, store: manager.store, version: 1);
  }

  void setFlag(String channelId, bool value) =>
      _manager?.setFlag(channelId, value);

  void _emitManagerState(ChannelFlagManager<E, S> manager) {
    if (_manager != manager) return;
    state = stateFor(
      isReady: true,
      store: manager.store,
      version: state.version + 1,
    );
  }
}

String? _safePubkeyFromNsec(String nsec) {
  try {
    final privkeyHex = nostr.Nip19.decode(payload: nsec).data;
    if (privkeyHex.isEmpty) return null;
    return nostr.Keys(privkeyHex).public;
  } catch (_) {
    return null;
  }
}

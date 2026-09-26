import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// One channel's value for a synced per-channel flag (mute, star, …).
///
/// Subclasses name the value for their flag (`starred`, `muted`) and fix the
/// JSON field it is stored under; the field is part of the persisted and
/// relay wire format.
abstract class ChannelFlagEntry {
  final bool value;
  final int updatedAt;

  const ChannelFlagEntry({required this.value, required this.updatedAt});
}

/// A flag's per-channel entries, stored as
/// `{version: 1, channels: {<id>: {<field>: bool, updatedAt: int}}}`.
abstract class ChannelFlagStore<E extends ChannelFlagEntry> {
  final int version;
  final Map<String, E> channels;

  const ChannelFlagStore({this.version = 1, this.channels = const {}});

  Map<String, dynamic> toJsonWithField(String field) => {
    'version': version,
    'channels': {
      for (final e in channels.entries)
        e.key: {field: e.value.value, 'updatedAt': e.value.updatedAt},
    },
  };
}

/// Parses the `channels` object of a flag payload, keeping only well-formed
/// entries for [field].
Map<String, E> parseFlagChannels<E extends ChannelFlagEntry>(
  Map<String, dynamic> json,
  String field,
  E Function(bool value, int updatedAt) entry,
) {
  final rawChannels = json['channels'];
  final channels = <String, E>{};
  if (rawChannels is Map) {
    for (final item in rawChannels.entries) {
      if (item.key is String && item.value is Map<String, dynamic>) {
        final v = item.value as Map<String, dynamic>;
        if (v[field] is bool && v['updatedAt'] is int) {
          channels[item.key as String] = entry(
            v[field] as bool,
            v['updatedAt'] as int,
          );
        }
      }
    }
  }
  return channels;
}

/// Per-channel max-updatedAt merge: for each channel ID in the union, keep
/// the entry with the highest updatedAt (local wins ties).
Map<String, E> mergeFlagChannels<E extends ChannelFlagEntry>(
  Map<String, E> local,
  Map<String, E> remote,
) {
  final merged = <String, E>{...local};
  for (final entry in remote.entries) {
    final existing = merged[entry.key];
    if (existing == null || entry.value.updatedAt > existing.updatedAt) {
      merged[entry.key] = entry.value;
    }
  }
  return merged;
}

/// How one flag is stored locally and carried on the relay.
class ChannelFlagSpec<
  E extends ChannelFlagEntry,
  S extends ChannelFlagStore<E>
> {
  /// JSON field of the entry's boolean. Part of the wire format.
  final String field;

  /// SharedPreferences key before `:<pubkey>`. Part of the persisted format.
  final String storageKeyPrefix;

  /// `d` (and `t`) tag of the encrypted relay blob. Part of the wire format.
  final String dTag;

  /// Prefix for debug logging, e.g. `ChannelMutesManager`.
  final String logName;

  final E Function(bool value, int updatedAt) entry;
  final S Function(Map<String, E> channels) store;

  const ChannelFlagSpec({
    required this.field,
    required this.storageKeyPrefix,
    required this.dTag,
    required this.logName,
    required this.entry,
    required this.store,
  });

  String storageKey(String pubkey) => '$storageKeyPrefix:$pubkey';

  S fromJson(Map<String, dynamic> json) =>
      store(parseFlagChannels(json, field, entry));

  S merge(S local, S remote) =>
      store(mergeFlagChannels(local.channels, remote.channels));
}

class ChannelFlagStorage<
  E extends ChannelFlagEntry,
  S extends ChannelFlagStore<E>
> {
  final ChannelFlagSpec<E, S> spec;
  final SharedPreferences _prefs;

  ChannelFlagStorage(this.spec, this._prefs);

  S read(String pubkey) {
    final raw = _prefs.getString(spec.storageKey(pubkey));
    if (raw == null || raw.isEmpty) {
      return spec.store(const {});
    }

    try {
      final parsed = jsonDecode(raw);
      if (parsed is! Map<String, dynamic>) {
        return spec.store(const {});
      }
      if (parsed['version'] != 1) {
        return spec.store(const {});
      }
      return spec.fromJson(parsed);
    } catch (_) {
      return spec.store(const {});
    }
  }

  Future<bool> write(String pubkey, S store) => _prefs.setString(
    spec.storageKey(pubkey),
    jsonEncode(store.toJsonWithField(spec.field)),
  );
}

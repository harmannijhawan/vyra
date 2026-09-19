/**
 * ProviderRegistryImpl — the concrete registry behind @vyra/shared's
 * ProviderRegistry contract.
 *
 * Selection is persisted through an injected SettingsStore so the
 * production registry can be wired to VYRA's settings DB while tests use
 * the in-memory default. Selection is per ProviderKind and stored under
 * the key `providers.<kind>`.
 */
import type {
  BaseProvider,
  ProviderKind,
  ProviderRegistry,
} from '@vyra/shared';

/** Minimal key/value store for persisted provider selection. */
export interface SettingsStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

/** In-memory SettingsStore — the default, used by tests and tooling. */
export class InMemorySettings implements SettingsStore {
  private readonly map = new Map<string, string>();

  get(key: string): string | undefined {
    return this.map.get(key);
  }

  set(key: string, value: string): void {
    this.map.set(key, value);
  }
}

function settingsKey(kind: ProviderKind): string {
  return `providers.${kind}`;
}

export class ProviderRegistryImpl implements ProviderRegistry {
  private readonly providers = new Map<ProviderKind, Map<string, BaseProvider>>();

  constructor(private readonly settings: SettingsStore = new InMemorySettings()) {}

  register(kind: ProviderKind, provider: BaseProvider): void {
    let byKind = this.providers.get(kind);
    if (!byKind) {
      byKind = new Map();
      this.providers.set(kind, byKind);
    }
    byKind.set(provider.id, provider);
  }

  get<T extends BaseProvider>(kind: ProviderKind, id?: string): T | undefined {
    const byKind = this.providers.get(kind);
    if (!byKind || byKind.size === 0) return undefined;
    if (id !== undefined) return byKind.get(id) as T | undefined;
    const selectedId = this.selected(kind);
    if (selectedId) {
      const selected = byKind.get(selectedId);
      if (selected) return selected as T;
    }
    // Fall back to the first registered provider for this kind.
    return byKind.values().next().value as T | undefined;
  }

  list(kind: ProviderKind): BaseProvider[] {
    const byKind = this.providers.get(kind);
    return byKind ? [...byKind.values()] : [];
  }

  selected(kind: ProviderKind): string | undefined {
    const stored = this.settings.get(settingsKey(kind));
    if (!stored) return undefined;
    // A stored id that no longer has a registered provider is ignored.
    return this.providers.get(kind)?.has(stored) ? stored : undefined;
  }

  select(kind: ProviderKind, id: string): void {
    const byKind = this.providers.get(kind);
    if (!byKind || !byKind.has(id)) {
      throw new Error(
        `Cannot select unknown provider "${id}" for kind "${kind}"`,
      );
    }
    this.settings.set(settingsKey(kind), id);
  }

  async probeAll(): Promise<
    Record<string, { id: string; available: boolean; reason?: string }>
  > {
    const report: Record<
      string,
      { id: string; available: boolean; reason?: string }
    > = {};
    for (const [kind, byKind] of this.providers) {
      for (const provider of byKind.values()) {
        const key = `${kind}:${provider.id}`;
        try {
          const capability = await provider.checkAvailability();
          report[key] = {
            id: provider.id,
            available: capability.available,
            reason: capability.reason,
          };
        } catch (err) {
          // A crashing probe is itself an honest "unavailable" signal.
          report[key] = {
            id: provider.id,
            available: false,
            reason:
              err instanceof Error
                ? `Probe failed: ${err.message}`
                : 'Probe failed with an unknown error',
          };
        }
      }
    }
    return report;
  }
}

/**
 * A placeholder provider for capabilities whose real implementation lives
 * in another package that isn't available here yet (e.g. voice STT/TTS
 * adapters from @vyra/voice before that package lands). Always reports
 * unavailable with an honest reason — never pretends to work.
 */
export class UnavailableProvider implements BaseProvider {
  constructor(
    readonly id: string,
    readonly displayName: string,
    private readonly unavailableReason: string,
  ) {}

  async checkAvailability(): Promise<{ available: boolean; reason?: string }> {
    return { available: false, reason: this.unavailableReason };
  }
}

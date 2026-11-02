/**
 * The Collection run variable scope: which value a `{{var}}` has when a request
 * starts, and how a script's writes are folded back afterwards.
 *
 * Layers, lowest to highest (a later layer wins):
 *
 *   globals          app only: `pm.globals`, no CLI equivalent
 *   environment
 *   carried          (app) script writes from EARLIER iterations
 *   collection
 *   folder           the request's folder variables, outer to inner
 *   overrides        CLI `--env-var`; the app has none
 *   carried          (CLI) script writes from EARLIER iterations
 *   data row         this iteration's row
 *   iteration writes script writes made THIS iteration
 *
 * A script write this iteration therefore beats the data row, and a write from
 * an earlier iteration sits below the next row. The two hosts differ on where
 * those earlier writes sit relative to folder and collection variables, and on
 * whether a `pm.collectionVariables` write is substituted into `{{var}}`. Both
 * are named in {@link RunScopePolicy}; the exported policies state which host
 * has which.
 */
import { applyVarMutations } from '../collections/variable-mutations';

export type VarMap = Record<string, string>;
export type VarMutations = Record<string, string | null>;

export interface RunScopePolicy {
  /**
   * Where script writes from earlier iterations sit: `above-folder` keeps them
   * above folder variables and below the data row; `below-collection` puts them
   * under the collection layer, so a folder or collection default wins again.
   */
  carriedWrites: 'above-folder' | 'below-collection';
  /**
   * Whether a `pm.collectionVariables` write shows up in `{{var}}` substitution
   * of later requests. When false it is visible to `pm.collectionVariables`
   * only; substitution keeps the values the run started with.
   */
  collectionWritesSubstitute: boolean;
  /**
   * Keep every variable write in a run-wide layer below folder variables, so a
   * same-key collection write cancels the override but not the value.
   */
  retainWrites: boolean;
}

/** The app's Collection run. */
export const APP_SCOPE_POLICY: RunScopePolicy = {
  carriedWrites: 'below-collection',
  collectionWritesSubstitute: true,
  retainWrites: false,
};

/** The CLI's Collection run. */
export const CLI_SCOPE_POLICY: RunScopePolicy = {
  carriedWrites: 'above-folder',
  collectionWritesSubstitute: false,
  retainWrites: true,
};

export interface RunScopeInit {
  policy: RunScopePolicy;
  /** App only. Mutated by `pm.globals` writes; omit for a host with no globals. */
  globals?: VarMap | undefined;
  environment?: VarMap | undefined;
  /** The live `pm.collectionVariables` backing map. Mutated by collection writes. */
  collection: VarMap;
  /** CLI `--env-var`. */
  overrides?: VarMap | undefined;
}

/** One script phase's effect, as the hosts get it from the executor. */
export interface PhaseWrites {
  /** The variable map the phase started from. */
  before: VarMap;
  /** The variable map the phase ended with. */
  after: VarMap;
  collectionMutations?: VarMutations | undefined;
  globalsMutations?: VarMutations | undefined;
}

export class RunScope {
  /** The live `pm.collectionVariables` map, for the executor. */
  readonly collection: VarMap;
  private readonly policy: RunScopePolicy;
  private readonly globals: VarMap | undefined;
  private readonly environment: VarMap;
  private readonly overrides: VarMap;
  /** The collection values the run started with (substitution when writes do not substitute). */
  private readonly collectionAtStart: VarMap;
  private readonly carried: VarMap = {};
  private readonly retained: VarMap = {};

  constructor(init: RunScopeInit) {
    this.policy = init.policy;
    this.globals = init.globals;
    this.environment = { ...(init.environment ?? {}) };
    this.collection = init.collection;
    this.overrides = { ...(init.overrides ?? {}) };
    this.collectionAtStart = { ...init.collection };
  }

  /** The `pm.globals` map as it stands, or undefined for a host without globals. */
  globalValues(): VarMap | undefined {
    return this.globals;
  }

  beginIteration(row: Readonly<VarMap>): IterationScope {
    return new IterationScope(this, row, {
      policy: this.policy,
      globals: this.globals,
      environment: this.environment,
      collectionForSubstitution: () =>
        this.policy.collectionWritesSubstitute ? this.collection : this.collectionAtStart,
      overrides: this.overrides,
      carried: this.carried,
      retained: this.retained,
    });
  }
}

interface ScopeLayers {
  policy: RunScopePolicy;
  globals: VarMap | undefined;
  environment: VarMap;
  collectionForSubstitution: () => VarMap;
  overrides: VarMap;
  carried: VarMap;
  retained: VarMap;
}

export class IterationScope {
  private readonly writes: VarMap = {};
  /** Collection unsets: hidden from lower scopes until this iteration ends (app). */
  private readonly unset = new Set<string>();

  constructor(
    private readonly run: RunScope,
    private readonly row: Readonly<VarMap>,
    private readonly layers: ScopeLayers
  ) {}

  /** The variable map a request starts with. `folder` is its merged folder variables. */
  requestVars(folder: Readonly<VarMap> = {}): VarMap {
    const { policy, globals, environment, overrides, carried, retained } = this.layers;
    const collection = this.layers.collectionForSubstitution();
    if (policy.carriedWrites === 'below-collection') {
      const base: VarMap = { ...globals, ...environment, ...carried, ...collection };
      for (const key of this.unset) delete base[key];
      return { ...base, ...folder, ...this.row, ...this.writes };
    }
    return {
      ...globals,
      ...environment,
      ...collection,
      ...retained,
      ...folder,
      ...overrides,
      ...carried,
      ...this.row,
      ...this.writes,
    };
  }

  /**
   * Fold script phases back into the scope. A changed variable becomes an
   * iteration write (it beats the row now and is carried into later iterations);
   * an untouched one is left in its own layer, so a folder default or a row value
   * never leaks outside its scope. A `pm.collectionVariables` write goes to the
   * collection layer instead and cancels any variable write of the same key.
   * Returns the merged collection mutations (the later phase wins) for a host that
   * persists them.
   */
  absorb(phases: readonly PhaseWrites[]): VarMutations {
    const collectionMutations: VarMutations = {};
    for (const phase of phases) {
      for (const [key, value] of Object.entries(phase.after)) {
        if (value === phase.before[key]) continue;
        this.writes[key] = value;
        if (this.layers.policy.retainWrites) this.layers.retained[key] = value;
      }
      if (phase.collectionMutations) Object.assign(collectionMutations, phase.collectionMutations);
      if (phase.globalsMutations && this.layers.globals) {
        applyVarMutations(this.layers.globals, phase.globalsMutations);
      }
    }
    for (const key of Object.keys(collectionMutations)) {
      delete this.writes[key];
      delete this.layers.carried[key];
      if (!this.layers.policy.collectionWritesSubstitute) continue;
      if (collectionMutations[key] === null && !(key in this.row)) this.unset.add(key);
      else this.unset.delete(key);
    }
    applyVarMutations(this.run.collection, collectionMutations);
    return collectionMutations;
  }

  /** The iteration ran to its end: its writes carry into later iterations. */
  end(): void {
    Object.assign(this.layers.carried, this.writes);
  }
}

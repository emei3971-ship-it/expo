import type { MixedOutput, Module, ReadOnlyGraph } from '@expo/metro/metro/DeltaBundler/types';
import { isResolvedDependency } from '@expo/metro/metro/lib/isResolvedDependency';

import type { AsyncDependencyType } from '../transform-worker/collect-dependencies';

export type BitSet = bigint;
type GraphModule = Module<MixedOutput>;

function validateIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error('BitSet indices and counts must be a non-negative safe integer.');
  }
}

export function addBit(bits: BitSet, index: number): BitSet {
  validateIndex(index);
  return bits | (1n << BigInt(index));
}

export function removeBit(bits: BitSet, index: number): BitSet {
  validateIndex(index);
  return bits & ~(1n << BigInt(index));
}

export function hasBit(bits: BitSet, index: number): boolean {
  validateIndex(index);
  return (bits & (1n << BigInt(index))) !== 0n;
}

export function allBits(count: number): BitSet {
  validateIndex(count);
  return (1n << BigInt(count)) - 1n;
}

export function* bitIndices(bits: BitSet): IterableIterator<number> {
  if (bits < 0n) throw new Error('BitSet iteration requires a non-negative value.');
  for (let index = 0; bits !== 0n; index++, bits >>= 1n) {
    if ((bits & 1n) !== 0n) yield index;
  }
}

export interface PlannerEntrypoint {
  readonly module: GraphModule;
  readonly kind: 'initial' | 'dynamic';
}

export interface BitSetGraphAnalysis {
  readonly entrypoints: readonly PlannerEntrypoint[];
  readonly dependentEntriesByModule: ReadonlyMap<GraphModule, BitSet>;
  readonly importerEntriesByDynamicEntry: readonly BitSet[];
  readonly dynamicImportsByEntry: readonly BitSet[];
}

function compareModules(a: GraphModule, b: GraphModule): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Analyze only the page realm of a complete export graph, without changing it. */
export function analyzeBitSetGraph(
  initialEntries: readonly GraphModule[],
  graph: ReadOnlyGraph,
  { isLazyBundle }: { isLazyBundle: boolean }
): BitSetGraphAnalysis {
  if (isLazyBundle) {
    throw new Error(
      'BitSet chunking requires a complete non-lazy export graph. Disable lazy bundling.'
    );
  }
  if (initialEntries.length === 0) {
    throw new Error('BitSet chunking requires an initial entry. Pass the export entry module.');
  }

  const entriesByPath = new Map<string, PlannerEntrypoint>();
  for (const entry of initialEntries) {
    const module = graph.dependencies.get(entry.path);
    if (!module) {
      throw new Error(
        `BitSet initial entry ${entry.path} is missing. Supply a complete export graph.`
      );
    }
    entriesByPath.set(module.path, { module, kind: 'initial' });
  }

  // Cache resolved page edges once. Weak references do not cause code to load;
  // workers have their own realm and are collected by the existing worker path.
  const edges = new Map<GraphModule, { target: GraphModule; dynamic: boolean }[]>();
  const queue = [...entriesByPath.values()].map((entry) => entry.module);
  for (let index = 0; index < queue.length; index++) {
    const module = queue[index]!;
    if (edges.has(module)) continue;
    const moduleEdges: { target: GraphModule; dynamic: boolean }[] = [];
    edges.set(module, moduleEdges);
    for (const dependency of module.dependencies.values()) {
      const asyncType = dependency.data.data.asyncType as AsyncDependencyType | null;
      if (!isResolvedDependency(dependency) || asyncType === 'weak') continue;
      const target = graph.dependencies.get(dependency.absolutePath);
      if (!target) {
        throw new Error(
          `BitSet dependency from ${module.path} to ${dependency.absolutePath} is missing. ` +
            'Production chunking requires a complete export graph; check graph transforms and disable lazy bundling.'
        );
      }
      if (asyncType === 'worker') {
        continue;
      }
      const dynamic = asyncType != null;
      if (dynamic && !entriesByPath.has(target.path)) {
        entriesByPath.set(target.path, { module: target, kind: 'dynamic' });
      }
      moduleEdges.push({ target, dynamic });
      queue.push(target);
    }
  }

  const entrypoints = [...entriesByPath.values()].sort((a, b) =>
    compareModules(a.module, b.module)
  );
  const entryIndexByPath = new Map(entrypoints.map((entry, index) => [entry.module.path, index]));
  const dependentEntriesByModule = new Map<GraphModule, BitSet>();
  for (const [entryIndex, entry] of entrypoints.entries()) {
    const pending = [entry.module];
    const entryMask = 1n << BigInt(entryIndex);
    for (let index = 0; index < pending.length; index++) {
      const module = pending[index]!;
      const owners = dependentEntriesByModule.get(module) ?? 0n;
      if ((owners & entryMask) !== 0n) continue;
      dependentEntriesByModule.set(module, owners | entryMask);
      for (const edge of edges.get(module)!) {
        if (!edge.dynamic) pending.push(edge.target);
      }
    }
  }

  const importerEntriesByDynamicEntry = entrypoints.map(() => 0n);
  const dynamicImportsByEntry = entrypoints.map(() => 0n);
  for (const [module, moduleEdges] of edges) {
    const importerBits = dependentEntriesByModule.get(module)!;
    for (const edge of moduleEdges) {
      if (!edge.dynamic) continue;
      const targetIndex = entryIndexByPath.get(edge.target.path)!;
      // An initial entry always keeps its kind, even when dynamically imported.
      if (entrypoints[targetIndex]!.kind === 'initial') continue;
      importerEntriesByDynamicEntry[targetIndex] =
        importerEntriesByDynamicEntry[targetIndex]! | importerBits;
      for (const importerIndex of bitIndices(importerBits)) {
        dynamicImportsByEntry[importerIndex] = addBit(
          dynamicImportsByEntry[importerIndex]!,
          targetIndex
        );
      }
    }
  }

  return {
    entrypoints,
    dependentEntriesByModule: new Map(
      [...dependentEntriesByModule].sort(([a], [b]) => compareModules(a, b))
    ),
    importerEntriesByDynamicEntry,
    dynamicImportsByEntry,
  };
}

import OpenAI from "./openai";
import { buildTree, expandTree, pathToNodeWithId, type Token } from "./logit-loom";
import { useSyncExternalStore } from "react";

export function useTreeStore(): State {
  return useSyncExternalStore(subscribe, getSnapshot);
}

let listeners: Array<() => void> = [];
export interface State {
  running: boolean;
  interrupting: boolean;
  value: { kind: "tree"; roots: Token[] } | { kind: "error"; error: any };
}
let state: State = {
  running: false,
  interrupting: false,
  value: { kind: "tree", roots: [] },
};

function subscribe(listener: () => void): () => void {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function emitChange() {
  for (let listener of listeners) {
    listener();
  }
}

function getSnapshot(): State {
  return state;
}

/** Return the token string for a given token -- all the tokens before it, and itself, joined together. */
export function getTokenAndPrefix(state: State, id: string): string | null {
  if (state.value.kind !== "tree") {
    return null;
  }
  const path = pathToNodeWithId(id, state.value.roots);
  if (path === null) {
    return null;
  }
  return path.map((t) => t.text).join("");
}

export function loadTreeFromLocalStorage() {
  state = { ...state, value: { kind: "tree", roots: tryGetTreeFromLocalStorage() } };
  emitChange();
}

export function interruptRun() {
  if (!state.running || state.interrupting) {
    return;
  }
  state = { ...state, interrupting: true };
  emitChange();
}

export function run(opts: {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  modelType: "chat" | "base";
  prompt: string | undefined;
  prefill: string | undefined;
  depth: number;
  maxWidth: number;
  coverProb: number;
  fromNodeId?: string;
}) {
  if (state.running) {
    return;
  }

  const client = new OpenAI({
    baseURL: opts.baseUrl,
    apiKey: opts.apiKey,
    dangerouslyAllowBrowser: true,
  });

  state = { ...state, running: true };
  emitChange();

  function progress(roots: Token[]) {
    state = { ...state, value: { kind: "tree", roots } };
    trySyncTreeToLocalStorage(roots);
    emitChange();
    return state.interrupting; // interrupt if user requested it
  }

  let promise: Promise<Token[]>;
  if (opts.fromNodeId == null) {
    promise = buildTree({
      client,
      baseUrl: opts.baseUrl,
      model: opts.modelName,
      modelType: opts.modelType,
      prompt: opts.prompt,
      prefill: opts.prefill,
      depth: opts.depth,
      maxWidth: opts.maxWidth,
      coverProb: opts.coverProb,
      progress,
    });
  } else {
    if (state.value.kind !== "tree") {
      throw new Error(`ui bug: state missing tree, can't expand '${opts.fromNodeId}' (how did you get this id?)`);
    }
    promise = expandTree(
      {
        client,
        baseUrl: opts.baseUrl,
        model: opts.modelName,
        modelType: opts.modelType,
        prompt: opts.prompt,
        prefill: opts.prefill,
        depth: opts.depth,
        maxWidth: opts.maxWidth,
        coverProb: opts.coverProb,
        progress,
      },
      state.value.roots,
      opts.fromNodeId
    );
  }

  promise
    .then((roots) => {
      state = { value: { kind: "tree", roots }, running: false, interrupting: false };
      trySyncTreeToLocalStorage(roots);
      emitChange();
    })
    .catch((error) => {
      state = {
        running: false,
        interrupting: false,
        value: { kind: "error", error },
      };
      emitChange();
      console.error(error);
    });
}

const treeLocalStorageKey = "prevTree";

/** Get the previous tree from localStorage, or an empty tree on error / missing tree. */
function tryGetTreeFromLocalStorage(): Token[] {
  try {
    const value = localStorage.getItem(treeLocalStorageKey);
    if (value == null) {
      return [];
    }
    const tree = JSON.parse(value);
    if (!Array.isArray(tree)) {
      // TODO: basic validation, should really parse this with zod or something
      console.warn(`item in prevTree doesn't seem to be a tree?`, tree);
      return [];
    }
    console.log("loaded tree from localStorage:", tree);
    return tree as Token[];
  } catch (e) {
    console.error("getting tree from localStorage:", e);
    return [];
  }
}

/** Attempt to sync the tree to localStorage. */
function trySyncTreeToLocalStorage(roots: Token[]) {
  try {
    localStorage.setItem(treeLocalStorageKey, JSON.stringify(roots));
  } catch (e) {
    console.error("persisting tree to localStorage:", e);
  }
}

/** Export the current tree to JSON. */
export function saveTreeToFile(): void {
  if (state.running) {
    return;
  }
  if (state.value.kind !== "tree") {
    console.error("export failed: no valid tree data");
    return;
  }
  
  const treeData = JSON.stringify(state.value.roots, null, 2);
  const blob = new Blob([treeData], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement("a");
  a.href = url;
  a.download = `logitloom.json`;
  document.body.appendChild(a);
  a.click();
  
  // Clean up
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Import a tree from a JSON file and update the state. */
export function loadTreeFromFile(file: File): Promise<void> {
  return new Promise((resolve, reject) => {
    if (state.running) {
      reject(new Error("can't load tree while running"));
      return;
    }

    const reader = new FileReader();
    
    reader.onload = (event) => {
      try {
        if (!event.target || typeof event.target.result !== "string") {
          throw new Error("failed to read file");
        }
        
        const treeData = JSON.parse(event.target.result);
        if (!Array.isArray(treeData)) {
          throw new Error("invalid tree format: expected an array");
        }
        
        // Update state with imported tree
        state = { ...state, value: { kind: "tree", roots: treeData } };
        trySyncTreeToLocalStorage(treeData);
        emitChange();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    
    reader.onerror = () => reject(new Error("error reading file"));
    reader.readAsText(file);
  });
}

/** Reset the tree to an empty state. */
export function resetTree(): void {
  if (state.running) {
    return;
  }

  const emptyTree: Token[] = [];
  state = { ...state, value: { kind: "tree", roots: emptyTree } };
  trySyncTreeToLocalStorage(emptyTree);
  emitChange();
}

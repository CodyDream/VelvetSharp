/** Phase 12 probe — pure-module smoke for the prefix-chain completion cache.
 *  Locks the fix for the bug the user's other agent found by reading the code:
 *  the old cache required an EXACT prefix match while its comment promised to
 *  help "the NEXT keystroke (a longer prefix)" — impossible by construction.
 * Run: npx tsx scripts/probe-phase12.ts  (exit 0 = all green)
 */
import {
  newCacheStore, cacheLookup, cacheStore,
  type CacheStore,
} from "../app/src/completion-cache";

const results: [string, boolean][] = [];
const check = (name: string, ok: boolean) => { results.push([name, !!ok]); console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}`); };

const item = (label: string, filterText?: string) => ({ label, ...(filterText ? { filterText } : {}) });

// -- exact prefix still works --
const s1: CacheStore = newCacheStore();
cacheStore(s1, "A.cs", "tr", [item("transform"), item("Translate"), item("Track")]);
check("CACHE-a exact prefix returns the cached items",
  cacheLookup(s1, "A.cs", "tr").length === 3);

// -- THE FIX: longer prefix chains off the shorter cached one --
const longer = cacheLookup(s1, "A.cs", "trans");
check("CACHE-b longer prefix ('trans') hits the 'tr' entry and filters it",
  longer.length === 2 && longer.every((i) => i.label.toLowerCase().startsWith("trans")));
check("CACHE-c even longer prefix ('transf') keeps filtering",
  cacheLookup(s1, "A.cs", "transf").map((i) => i.label).join().toLowerCase() === "transform");

// -- unrelated prefix must not leak the other entry --
check("CACHE-d unrelated prefix ('zz') matches nothing from 'tr'",
  cacheLookup(s1, "A.cs", "zz").length === 0);

// -- case-insensitive filtering --
check("CACHE-e filter is case-insensitive", cacheLookup(s1, "A.cs", "TR").length === 3);

// -- empty-string entry acts as a universe (just-typed-first-letter) --
const s2: CacheStore = newCacheStore();
cacheStore(s2, "B.cs", "", [item("alpha"), item("beta")]);
check("CACHE-f empty-prefix entry matches every prefix (universe)",
  cacheLookup(s2, "B.cs", "al").length === 1 && cacheLookup(s2, "B.cs", "b").length === 1);

// -- universe is shadowed by a more specific entry (longest prefix wins) --
cacheStore(s2, "B.cs", "al", [item("alpha2"), item("alphabet")]);
check("CACHE-g longest cached prefix wins over the universe",
  cacheLookup(s2, "B.cs", "al").length === 2 && cacheLookup(s2, "B.cs", "be").length === 1);

// -- filterText participates when present (label is display-only) --
const s3: CacheStore = newCacheStore();
cacheStore(s3, "C.cs", "g", [item("Go", "gameObject"), item("Other", "other")]);
check("CACHE-h filterText ?? label drives the filter",
  cacheLookup(s3, "C.cs", "game").length === 1 && cacheLookup(s3, "C.cs", "gab").length === 0);

// -- ring: same-prefix entries are replaced, cap is 8, newest first --
const s4: CacheStore = newCacheStore();
cacheStore(s4, "D.cs", "a", [item("a1")]);
cacheStore(s4, "D.cs", "a", [item("a2")]);
check("CACHE-i same-prefix store replaces (no dupes)",
  s4.get("D.cs")!.length === 1 && cacheLookup(s4, "D.cs", "a")[0].label === "a2");
for (let i = 0; i < 12; i++) cacheStore(s4, "D.cs", `p${i}`, [item(`x${i}`)]);
check("CACHE-j ring caps at 8 entries per file", s4.get("D.cs")!.length === 8);

// -- empty item lists are never stored (an empty cache must not shadow) --
const s5: CacheStore = newCacheStore();
cacheStore(s5, "E.cs", "q", []);
check("CACHE-k empty answers are not cached", !s5.has("E.cs"));

// -- per-path isolation --
check("CACHE-l caches are isolated per file", cacheLookup(s1, "Other.cs", "tr").length === 0);

const failed = results.filter(([, ok]) => !ok);
console.log(`\n=========== Phase 12 cache RESULT: ${results.length - failed.length}/${results.length} PASS ===========`);
for (const [name] of failed) console.log("  FAILED:", name);
if (failed.length) process.exitCode = 2;

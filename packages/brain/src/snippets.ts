/** VelvetSharp brain — Unity & C# snippet templates + Unity message catalog */

export interface SnippetDef { label: string; detail: string; body: string; kind: "snippet" }

export interface LifecycleDef { name: string; params: string; doc: string }

/** The full Unity MonoBehaviour/Behaviour message catalog used for:
 *  - member-level completions ("insert Unity method")
 *  - semantic highlighting of special function names
 *  - outline panel badges */
export const UNITY_LIFECYCLE: LifecycleDef[] = [
  { name: "Awake", params: "", doc: "Called when the script instance is being loaded." },
  { name: "OnEnable", params: "", doc: "Called when the object becomes enabled and active." },
  { name: "Start", params: "", doc: "Called on the frame when a script is enabled, before any Update call." },
  { name: "FixedUpdate", params: "", doc: "Frame-rate independent message for physics computations." },
  { name: "Update", params: "", doc: "Called every frame, if the MonoBehaviour is enabled." },
  { name: "LateUpdate", params: "", doc: "Called every frame, after all Update functions have been called." },
  { name: "OnDisable", params: "", doc: "Called when the behaviour becomes disabled or inactive." },
  { name: "OnDestroy", params: "", doc: "Called when the MonoBehaviour will be destroyed." },
  { name: "OnApplicationFocus", params: "bool hasFocus", doc: "Called when the application gains or loses focus." },
  { name: "OnApplicationPause", params: "bool pauseStatus", doc: "Called when the application pauses." },
  { name: "OnApplicationQuit", params: "", doc: "Called on application quit, before the application exits." },
  { name: "OnValidate", params: "", doc: "Called when the script is loaded or a value changes in the Inspector (Editor only)." },
  { name: "Reset", params: "", doc: "Called to reset script properties in the Inspector (Editor only)." },
  { name: "OnGUI", params: "", doc: "Called for rendering and handling GUI events." },
  { name: "OnDrawGizmos", params: "", doc: "Draw gizmos that are always visible in the Scene view." },
  { name: "OnDrawGizmosSelected", params: "", doc: "Draw gizmos only when the object is selected." },
  { name: "OnTriggerEnter", params: "Collider other", doc: "Called when a Collider enters another trigger." },
  { name: "OnTriggerStay", params: "Collider other", doc: "Called almost all the frames for every Collider other that is touching the trigger." },
  { name: "OnTriggerExit", params: "Collider other", doc: "Called when a Collider other has stopped touching the trigger." },
  { name: "OnCollisionEnter", params: "Collision collision", doc: "Called when this collider/rigidbody has begun touching another rigidbody/collider." },
  { name: "OnCollisionStay", params: "Collision collision", doc: "Called once per frame for every collider/rigidbody that is touching this one." },
  { name: "OnCollisionExit", params: "Collision collision", doc: "Called when this collider/rigidbody has stopped touching another rigidbody/collider." },
  { name: "OnControllerColliderHit", params: "ControllerColliderHit hit", doc: "Called when the CharacterController hits a collider while performing a Move." },
  { name: "OnParticleCollision", params: "GameObject other", doc: "Called when a particle hits a collider." },
  { name: "OnJointBreak", params: "float breakForce", doc: "Called when a joint attached to the same game object breaks." },
  { name: "OnMouseDown", params: "", doc: "Called when the user has pressed the mouse button while over the collider." },
  { name: "OnMouseDrag", params: "", doc: "Called while the user has clicked a collider and is still holding down the button." },
  { name: "OnMouseEnter", params: "", doc: "Called when the mouse entered the collider." },
  { name: "OnMouseExit", params: "", doc: "Called when the mouse is no longer over the collider." },
  { name: "OnMouseOver", params: "", doc: "Called every frame while the mouse is over the collider." },
  { name: "OnMouseUp", params: "", doc: "Called when the user has released the mouse button over the collider." },
  { name: "OnAnimatorMove", params: "", doc: "Callback for processing animation movement for modifying root motion." },
  { name: "OnAnimatorIK", params: "int layerIndex", doc: "Callback for setting up animation IK (inverse kinematics)." },
  { name: "OnBecameVisible", params: "", doc: "Called when the renderer became visible by any camera." },
  { name: "OnBecameInvisible", params: "", doc: "Called when the renderer is no longer visible by any camera." },
  { name: "OnTransformParentChanged", params: "", doc: "Called when the parent property of the transform has changed." },
  { name: "OnTransformChildrenChanged", params: "", doc: "Called when the list of children of the transform has changed." },
  { name: "OnRenderObject", params: "", doc: "Called after camera has rendered the scene." },
  { name: "OnWillRenderObject", params: "", doc: "Called once for each camera if the object is visible." },
  { name: "OnLevelWasLoaded", params: "int level", doc: "Called after a new level was loaded (legacy)." },
];

/** fast set lookup for semantic highlighting + outline badges */
export const UNITY_MESSAGE_NAMES: Set<string> = new Set(UNITY_LIFECYCLE.map((l) => l.name));

export const UNITY_SNIPPETS: SnippetDef[] = [
  {
    label: "MonoBehaviour",
    detail: "New MonoBehaviour script",
    kind: "snippet",
    body: [
      "using UnityEngine;",
      "",
      "public class ${1:NewScript} : MonoBehaviour",
      "{",
      "    private void Start()",
      "    {",
      "        ${2}",
      "    }",
      "",
      "    private void Update()",
      "    {",
      "        ${3}",
      "    }",
      "}",
    ].join("\n"),
  },
  {
    label: "ScriptableObject",
    detail: "New ScriptableObject asset",
    kind: "snippet",
    body: [
      "using UnityEngine;",
      "",
      "[CreateAssetMenu(fileName = \"${1:NewAsset}\", menuName = \"${2:Game}/${1:NewAsset}\")]",
      "public class ${1:NewAsset} : ScriptableObject",
      "{",
      "    ${3}",
      "}",
    ].join("\n"),
  },
  {
    label: "SerializeField",
    detail: "[SerializeField] private field",
    kind: "snippet",
    body: "[SerializeField] private ${1:int} ${2:myField};",
  },
  {
    label: "SerializeFieldFloat",
    detail: "[SerializeField] private float with header",
    kind: "snippet",
    body: "[Header(\"${3:Movement}\")]\n[SerializeField] private float ${2:speed} = ${1:5f};",
  },
  {
    label: "GetComponent",
    detail: "GetComponent<T>() pattern",
    kind: "snippet",
    body: "${1:Component} ${2:component} = GetComponent<${1:Component}>();",
  },
  {
    label: "Coroutine",
    detail: "IEnumerator + StartCoroutine",
    kind: "snippet",
    body: [
      "private IEnumerator ${1:MyRoutine}()",
      "{",
      "    yield return new WaitForSeconds(${2:1f});",
      "    ${3}",
      "}",
    ].join("\n"),
  },
  {
    label: "OnTriggerEnter",
    detail: "Trigger callback",
    kind: "snippet",
    body: "private void OnTriggerEnter(Collider ${1:other})\n{\n    ${2}\n}",
  },
  {
    label: "OnCollisionEnter",
    detail: "Collision callback",
    kind: "snippet",
    body: "private void OnCollisionEnter(Collision ${1:collision})\n{\n    ${2}\n}",
  },
  {
    label: "DebugLog",
    detail: "Debug.Log",
    kind: "snippet",
    body: "Debug.Log($1);",
  },
  {
    label: "Invoke",
    detail: "Invoke method after delay",
    kind: "snippet",
    body: "Invoke(nameof(${1:MethodName}), ${2:1f});",
  },
  {
    label: "Singleton",
    detail: "Singleton: static Instance + guarded Awake + OnDestroy cleanup",
    kind: "snippet",
    // the engine swaps in the enclosing class name (see buildSingletonSnippet)
    body: buildSingletonSnippet(null),
  },
  {
    label: "SingletonPersistent",
    detail: "Singleton that survives scene loads (DontDestroyOnLoad)",
    kind: "snippet",
    body: buildSingletonSnippet(null, { persistent: true }),
  },
  {
    label: "OnEnableDisable",
    detail: "OnEnable / OnDisable event subscribe + unsubscribe pair",
    kind: "snippet",
    body: [
      "private void OnEnable()",
      "{",
      "    ${1:Source}.${2:SomeEvent} += ${3:Handler};",
      "}",
      "",
      "private void OnDisable()",
      "{",
      "    ${1:Source}.${2:SomeEvent} -= ${3:Handler};",
      "}",
    ].join("\n"),
  },
  {
    label: "TryGetComponent",
    detail: "TryGetComponent with an error log + early return",
    kind: "snippet",
    body: [
      "if (!TryGetComponent(out ${1:Rigidbody} ${2:body}))",
      "{",
      "    Debug.LogError($\"{nameof(${1:Rigidbody})} is missing on '{name}'\", this);",
      "    return;",
      "}",
    ].join("\n"),
  },
  {
    label: "NullGuard",
    detail: "Unassigned-reference guard with error log + early return",
    kind: "snippet",
    body: [
      "if (${1:target} == null)",
      "{",
      "    Debug.LogError($\"{nameof(${1:target})} is not assigned on '{name}'\", this);",
      "    return;",
      "}",
    ].join("\n"),
  },
  {
    label: "RequireComponent",
    detail: "[RequireComponent(typeof(T))] attribute",
    kind: "snippet",
    body: "[RequireComponent(typeof(${1:Rigidbody}))]",
  },
  {
    label: "EventAction",
    detail: "public event Action<T> field",
    kind: "snippet",
    body: "public event System.Action<${1:int}> ${2:OnChanged};",
  },
  {
    label: "Cooldown",
    detail: "Time.time based cooldown (field, IsReady, StartCooldown)",
    kind: "snippet",
    body: [
      "[SerializeField] private float ${1:cooldown} = ${2:1f};",
      "private float ${3:nextReadyTime};",
      "",
      "private bool IsReady => Time.time >= ${3:nextReadyTime};",
      "",
      "private void StartCooldown()",
      "{",
      "    ${3:nextReadyTime} = Time.time + ${1:cooldown};",
      "}",
    ].join("\n"),
  },
  {
    label: "GizmoSphere",
    detail: "OnDrawGizmosSelected wire sphere",
    kind: "snippet",
    body: [
      "private void OnDrawGizmosSelected()",
      "{",
      "    Gizmos.color = ${1:Color.yellow};",
      "    Gizmos.DrawWireSphere(transform.position, ${2:radius});",
      "}",
    ].join("\n"),
  },
];

/** Singleton snippet body.
 *
 *  Generates, for the class the caret is in:
 *   - `public static <Type> Instance { get; private set; }`
 *   - Awake: if an Instance already exists (and it is not this one) log a warning
 *     and DO NOT assign; otherwise assign `Instance = this`
 *   - OnDestroy: only if `Instance == this`, null it — so a rejected duplicate
 *     being destroyed can never wipe the real instance
 *
 *  `typeName` is the enclosing class (plain text). When the caret is not inside
 *  a class it falls back to an editable `${1:Manager}` placeholder. */
export function buildSingletonSnippet(typeName: string | null, opts: { persistent?: boolean } = {}): string {
  const T = typeName ?? "${1:Manager}";
  // mirror the first placeholder instead of repeating its default text
  const Tref = typeName ?? "${1}";
  const lines = [
    `public static ${T} Instance { get; private set; }`,
    "",
    "private void Awake()",
    "{",
    "    if (Instance != null && Instance != this)",
    "    {",
    `        Debug.LogWarning($"Duplicate {nameof(${Tref})} on '{name}': an instance already exists on '{Instance.name}', not assigning.", this);`,
    "        return;",
    "    }",
    "",
    "    Instance = this;",
  ];
  if (opts.persistent) lines.push("    DontDestroyOnLoad(gameObject);");
  lines.push(
    "    ${0}",
    "}",
    "",
    "private void OnDestroy()",
    "{",
    "    if (Instance == this)",
    "    {",
    "        Instance = null;",
    "    }",
    "}",
  );
  return lines.join("\n");
}

export const CSHARP_KEYWORDS = [
  "abstract", "as", "base", "bool", "break", "byte", "case", "catch", "char", "class",
  "const", "continue", "decimal", "default", "do", "double", "else", "enum", "event",
  "explicit", "extern", "false", "finally", "fixed", "float", "for", "foreach", "get",
  "goto", "if", "implicit", "in", "int", "interface", "internal", "is", "lock", "long",
  "namespace", "new", "null", "object", "operator", "out", "override", "params",
  "private", "protected", "public", "readonly", "ref", "return", "sealed", "set",
  "short", "sizeof", "stackalloc", "static", "string", "struct", "switch", "this",
  "throw", "true", "try", "typeof", "uint", "ulong", "unchecked", "unsafe", "ushort",
  "using", "var", "virtual", "void", "volatile", "while", "yield",
];

/* --------------------------- C# statement snippets (v0.5.0) --------------------------- */

/** loop-variable pool: `for (int i = …)` bumps to j/k/l/m/n when already used */
const LOOP_VAR_POOL = ["i", "j", "k", "l", "m", "n", "p", "r", "t", "u", "v", "w"];
const FOREACH_VAR_POOL = ["item", "element", "entry", "current", "value"];

/** pick the first free identifier from a pool (whole words already taken anywhere
 *  in the file are skipped — so `for` snippets never shadow an existing `i`) */
export function pickLoopVar(taken: Iterable<string>, pool: "index" | "foreach" = "index"): string {
  const used = new Set(taken);
  const candidates = pool === "index" ? LOOP_VAR_POOL : FOREACH_VAR_POOL;
  for (const c of candidates) if (!used.has(c)) return c;
  // pools exhausted → numbered fallback
  const base = pool === "index" ? "i" : "item";
  let n = 2;
  while (used.has(base + n)) n++;
  return base + n;
}

/** `for` / `forr` bodies are built dynamically so the loop index can be bumped */
export function buildLoopSnippet(label: "for" | "forr", v: string): string {
  if (label === "for") {
    return `for (int ${v} = 0; ${v} < ${`\${1:count}`}; ${v}++)\n{\n    \${2}\n}`;
  }
  // forr — reverse iteration
  return `for (int ${v} = ${`\${1:count}`} - 1; ${v} >= 0; ${v}--)\n{\n    \${2}\n}`;
}

/** dynamic foreach body (its iteration variable also avoids clashes) */
export function buildForeachSnippet(v: string): string {
  return `foreach (var ${v} in \${1:collection})\n{\n    \${2}\n}`;
}

/** the classic statement snippets (if / while / for / forr / foreach / prop / try …) */
export const CSHARP_SNIPPETS: SnippetDef[] = [
  { label: "if", detail: "if statement", kind: "snippet", body: "if (${1:condition})\n{\n    ${2}\n}" },
  { label: "ifelse", detail: "if / else statement", kind: "snippet", body: "if (${1:condition})\n{\n    ${2}\n}\nelse\n{\n    ${3}\n}" },
  { label: "else", detail: "else block", kind: "snippet", body: "else\n{\n    ${1}\n}" },
  { label: "for", detail: "for loop (index auto-bumped: i→j→k…)", kind: "snippet", body: "" },
  { label: "forr", detail: "reverse for loop (index auto-bumped)", kind: "snippet", body: "" },
  { label: "foreach", detail: "foreach loop (variable auto-bumped)", kind: "snippet", body: "" },
  { label: "while", detail: "while loop", kind: "snippet", body: "while (${1:condition})\n{\n    ${2}\n}" },
  { label: "do", detail: "do / while loop", kind: "snippet", body: "do\n{\n    ${1}\n} while (${2:condition});" },
  { label: "switch", detail: "switch statement", kind: "snippet", body: "switch (${1:value})\n{\n    case ${2:0}:\n        ${3}\n        break;\n    default:\n        ${4}\n        break;\n}" },
  { label: "try", detail: "try / catch", kind: "snippet", body: "try\n{\n    ${1}\n}\ncatch (${2:Exception} ${3:ex})\n{\n    ${4}\n}" },
  { label: "tryf", detail: "try / finally", kind: "snippet", body: "try\n{\n    ${1}\n}\nfinally\n{\n    ${2}\n}" },
  { label: "prop", detail: "auto-property", kind: "snippet", body: "public ${1:int} ${2:MyProperty} { get; set; }" },
  { label: "propfull", detail: "property with backing field", kind: "snippet", body: "private ${1:int} ${2:myField};\npublic ${1:int} ${3:MyProperty}\n{\n    get { return ${2:myField}; }\n    set { ${2:myField} = value; }\n}" },
  { label: "propuni", detail: "Unity serialized property", kind: "snippet", body: "[SerializeField] private ${1:int} ${2:myField};\npublic ${1:int} ${3:MyField}\n{\n    get => ${2:myField};\n    set => ${2:myField} = value;\n}" },
  { label: "ctor", detail: "constructor", kind: "snippet", body: "public ${1:ClassName}(${2})\n{\n    ${3}\n}" },
  { label: "cw", detail: "Debug.Log line", kind: "snippet", body: "Debug.Log($1);" },
];


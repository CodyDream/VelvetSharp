import { xmlDocSuggestion } from "../packages/brain/src/xmldoc";

const d0 = xmlDocSuggestion([
  "public class Player : MonoBehaviour",
  "{",
  "    /// cursor line",
  "    private void TakeDamage(float amount, GameObject source = null)",
  "    {",
  "    }",
  "}",
], 3);
console.log("d0:", JSON.stringify(d0, null, 1));

const d1 = xmlDocSuggestion([
  "public class Player : MonoBehaviour",
  "{",
  "    /// cursor line",
  "    public Vector3 GetTarget(float range, LayerMask mask)",
  "    {",
  "        return default;",
  "    }",
  "}",
], 3);
console.log("d1:", JSON.stringify(d1, null, 1));

const d6 = xmlDocSuggestion([
  "public class A",
  "{",
  "    /// cursor line",
  "    [Header(\"Stats\")]",
  "    [SerializeField]",
  "    private float moveSpeed = 6f;",
  "}",
], 2);
console.log("d6:", JSON.stringify(d6, null, 1));

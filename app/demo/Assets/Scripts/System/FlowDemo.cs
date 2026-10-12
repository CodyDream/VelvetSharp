using UnityEngine;
using System.Threading.Tasks;

namespace Game_Scripts.System
{
    /// Phase 9 demo — exercises the false-positive fixes (Array.Empty<int>(),
    /// bare Task) and the call-flow view (methods calling each other + externals).
    public class FlowDemo : MonoBehaviour
    {
        // singleton — the dependency graph draws a self-loop + "S" badge for this
        public static FlowDemo Instance;

        private int[] currentLoadout;
        private Task pendingWork;

        private void Awake()
        {
            Instance = this;
        }

        private void Start()
        {
            BuildPayload();
            pendingWork = Task.Delay(500);
        }

        // the exact pattern that used to false-positive CS0246 on 'Empty'
        public string BuildPayload()
        {
            var payload = new JObject
            {
                { "weapons", new JArray(currentLoadout ?? Array.Empty<int>()) }
            };
            LogPayload(payload);
            return payload.ToString();
        }

        private void LogPayload(object payload)
        {
            Debug.Log(payload);
        }

        public void Refresh(int[] loadout)
        {
            currentLoadout = loadout;
            ApplyLoadout();
        }

        private void ApplyLoadout()
        {
            BuildPayload();
        }
    }
}

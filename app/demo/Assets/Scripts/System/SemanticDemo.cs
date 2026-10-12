using System.Collections.Generic;
using System.Threading;
using UnityEngine;

/// <summary>Showcases VelvetSharp v0.4.0 deep semantic analysis:
/// unused variables, unreachable code (greyed out), missing returns,
/// interface/static instantiation errors, ref/out misuse and
/// obsolete API detection (strikethrough).</summary>
public class SemanticDemo : MonoBehaviour {
    private List<string> log = new List<string>();

    void Start() {
        int unusedVar = 42;
        log.Add("boot");
        return;
        Debug.Log("never runs");
    }

    int Score() {
        if (Time.frameCount > 10) {
            return 10;
        }
    }

    void Bad() {
        return 5;
        new IList();
        int.TryParse("7", out 3);
    }

    void Pause(Thread worker) {
        worker.Suspend();
    }
}

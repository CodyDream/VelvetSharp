using UnityEngine;

// This file intentionally contains syntax errors to show off VelvetSharp diagnostics.
public class BrokenScript : MonoBehaviour
{
    [SerializeField] private float speed = 5f

    private void Update()
    {
        transform.Translate(Vector3.forward * speed * Time.deltaTime);
        if (speed > 10f
        {
            Debug.LogWarning("Too fast!");
        }
    }

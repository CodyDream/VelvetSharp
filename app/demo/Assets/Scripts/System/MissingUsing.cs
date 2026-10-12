using System;

public class MissingUsing
{
    // Rigidbody is a UnityEngine type — no `using UnityEngine;` here
    public void Configure()
    {
        Rigidbody rb = null;
        rb.mass = 1f;
    }
}

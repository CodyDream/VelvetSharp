using System;
using UnityEngine;

public class V05Demo
{
    // overloads are legal — same name, different parameter lists
    public int Add(int a, int b) { return a + b; }
    public string Add(string a, string b) { return a + b; }

    // duplicate signature — must be flagged as an error
    public int Add(int a, int b) { return 0; }

    // void methods: bare return is fine, no value required
    public void Tick()
    {
        if (DateTime.UtcNow.Second > 30) return;
        Debug.Log("ticking");
    }

    // void methods cannot return a VALUE — must be flagged
    public void Bad()
    {
        return 5;
    }

    // non-void: every path must return; `return null` is legal for reference types
    public string Pick(bool flag)
    {
        if (flag) return null;
        return "default";
    }

    // interface naming: must start with I (warning on this line)
    public interface Repo
    {
        int Count();
    }

    // ambiguous reference: Object exists in UnityEngine AND System (both used)
    public Object Resolve()
    {
        return null;
    }
}

using UnityEngine;

/// <summary>
/// Stationary turret — derives EnemyAI (inherits detection logic) and
/// implements IDamageable so the dependency graph has an inheritance edge
/// and an interface edge to draw.
/// </summary>
public class Turret : EnemyAI, IDamageable
{
    [SerializeField] private EnemyHealth coreHealth;
    [SerializeField] private GameObject projectilePrefab;

    private GameManager game;

    private void OnEnable()
    {
        game = GameManager.Instance;
    }

    public void ApplyDamage(int amount)
    {
        coreHealth.TakeDamage(amount);
        if (!coreHealth.IsAlive)
        {
            Destroy(gameObject);
        }
    }

    bool IDamageable.IsAlive => coreHealth.IsAlive;
}

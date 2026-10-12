using UnityEngine;

[CreateAssetMenu(fileName = "NewWeapon", menuName = "Game/Weapon")]
public class WeaponData : ScriptableObject
{
    [SerializeField] private string weaponName = "Rusty Sword";
    [SerializeField] private float damage = 15f;
    [SerializeField] private float attackCooldown = 0.5f;
    [SerializeField] private GameObject hitEffect;

    public string WeaponName => weaponName;
    public float Damage => damage;
    public float AttackCooldown => attackCooldown;

    public void SpawnHitEffect(Vector3 position, Quaternion rotation)
    {
        if (hitEffect != null)
        {
            Instantiate(hitEffect, position, rotation);
        }
    }
}

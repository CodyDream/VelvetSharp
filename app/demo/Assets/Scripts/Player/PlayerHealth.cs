using UnityEngine;

public class PlayerHealth : MonoBehaviour
{
    [SerializeField] private int maxHealth = 100;
    private int currentHealth;

    public float HealthPercent => (float)currentHealth / maxHealth;

    private void OnEnable()
    {
        currentHealth = maxHealth;
    }

    public void TakeDamage(int amount)
    {
        currentHealth = Mathf.Max(0, currentHealth - amount);
        Debug.Log("Player took " + amount + " damage. HP: " + currentHealth);
        if (currentHealth == 0)
        {
            GameManager.Instance.ResetGame();
        }
    }

    public void Heal(int amount)
    {
        currentHealth = Mathf.Min(maxHealth, currentHealth + amount);
    }
}

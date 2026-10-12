using UnityEngine;

public class EnemyAI : MonoBehaviour
{
    [SerializeField] private float detectionRadius = 8f;
    [SerializeField] private float moveSpeed = 3f;
    [SerializeField] private int damage = 10;

    private Transform playerTransform;
    private EnemyHealth health;

    private void Start()
    {
        playerTransform = GameObject.FindGameObjectWithTag("Player").transform;
        health = GetComponent<EnemyHealth>();
    }

    private void Update()
    {
        float distance = Vector3.Distance(transform.position, playerTransform.position);
        if (distance < detectionRadius)
        {
            Vector3 direction = (playerTransform.position - transform.position).normalized;
            transform.position += direction * moveSpeed * Time.deltaTime;
            transform.LookAt(playerTransform);
        }
    }

    private void OnTriggerEnter(Collider other)
    {
        if (other.CompareTag("Player"))
        {
            other.GetComponent<PlayerHealth>().TakeDamage(damage);
        }
    }
}

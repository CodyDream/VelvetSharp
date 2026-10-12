using System.Collections;
using UnityEngine;

public class PlayerController : MonoBehaviour
{
    [Header("Movement")]
    [SerializeField] private float moveSpeed = 5f;
    [SerializeField] private float jumpForce = 12f;
    [SerializeField] private LayerMask groundLayer;

    [Header("References")]
    [SerializeField] private Transform groundCheck;
    [SerializeField] private Rigidbody playerRigidbody;

    private Vector3 spawnPoint;
    private bool isGrounded;
    private int coinsCollected;

    public int Coins => coinsCollected;

    private void Awake()
    {
        spawnPoint = transform.position;
    }

    private void Update()
    {
        float horizontal = Input.GetAxis("Horizontal");
        Vector3 velocity = playerRigidbody.velocity;
        velocity.x = horizontal * moveSpeed;
        playerRigidbody.velocity = velocity;

        if (Input.GetButtonDown("Jump") && isGrounded)
        {
            playerRigidbody.AddForce(Vector3.up * jumpForce, ForceMode.Impulse);
        }
    }

    private void FixedUpdate()
    {
        isGrounded = Physics.CheckSphere(groundCheck.position, 0.2f, groundLayer);
    }

    public void Respawn()
    {
        transform.position = spawnPoint;
        playerRigidbody.velocity = Vector3.zero;
        Debug.Log("Player respawned at " + spawnPoint);
    }
}

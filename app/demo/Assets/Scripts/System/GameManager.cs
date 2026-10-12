using System.Collections.Generic;
using UnityEngine;

public class GameManager : MonoBehaviour
{
    public static GameManager Instance { get; private set; }

    [SerializeField] private PlayerController player;
    [SerializeField] private int targetCoins = 10;

    private readonly List<string> eventLog = new List<string>();
    private GameState state = GameState.Playing;

    public GameState State => state;

    private void Awake()
    {
        if (Instance != null && Instance != this)
        {
            Destroy(gameObject);
            return;
        }
        Instance = this;
        DontDestroyOnLoad(gameObject);
    }

    public void RegisterCoin()
    {
        eventLog.Add("coin collected at " + Time.time);
        if (player.Coins >= targetCoins)
        {
            state = GameState.Victory;
            Debug.Log("Victory! Total coins: " + player.Coins);
        }
    }

    public void ResetGame()
    {
        state = GameState.Playing;
        eventLog.Clear();
        player.Respawn();
    }
}

public enum GameState
{
    Playing,
    Paused,
    Victory,
    GameOver
}

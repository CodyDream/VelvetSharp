using Game.Network;
using UnityEngine;

namespace Game.Server
{
    public class ServerKernel
    {
        private NetDriver driver = new NetDriver();

        private void Awake()
        {
            driver.Connect("127.0.0.1", 7777);
            driver.Send(new byte[] { 1, 2, 3 });
            transform.position = Vector3.zero;
        }
    }
}

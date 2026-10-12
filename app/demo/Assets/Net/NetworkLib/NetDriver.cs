namespace Game.Network
{
    public class NetDriver
    {
        public bool Connected { get; private set; }

        public void Connect(string host, int port)
        {
            Connected = true;
        }

        public void Send(byte[] payload)
        {
        }
    }
}

namespace Demo;

public class Greeter
{
	private readonly string _name;

	public Greeter(string name)
	{
		_name = name;
	}

	public string Greet() => $"Hi {_name}";

	public int Count { get; set; }
}

public interface IThing
{
	void Do();
}

public enum Color
{
	Red,
	Green,
}

public struct Point
{
	public int X;
	public int Y;
}

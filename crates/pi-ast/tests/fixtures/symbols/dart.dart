class Greeter {
	final String name;
	static const int max = 100;

	Greeter(this.name);

	String greet() => 'Hi $name';

	int get count => 0;
}

abstract class Animal {
	void speak();
}

mixin Walker {
	void walk() {}
}

enum Color {
	red,
	green,
	blue,
}

void topLevel() {
	print('hi');
}

const double pi = 3.14;

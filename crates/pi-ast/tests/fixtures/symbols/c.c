#define MAX_SIZE 100

typedef struct Point {
	int x;
	int y;
} Point;

typedef int Distance;

enum Color {
	RED,
	GREEN,
	BLUE,
};

static const int TIMEOUT = 30;

int add(int a, int b) {
	return a + b;
}

void move(Point *p, enum Color c) {
	p->x += MAX_SIZE;
}

#include <cstdio>

namespace app {

const int kLimit = 100;

enum Mode { READ, WRITE };

struct Vec {
	int x;
	int y;
	int length() { return x + y; }
};

class Counter {
public:
	Counter() : count_(0) {}
	void increment() { count_++; }
	int value() const { return count_; }
private:
	int count_;
};

template <typename T>
T identity(T x) { return x; }

}  // namespace app

int main() {
	return 0;
}

import Foundation

struct Point {
	var x: Double
	var y: Double
	func distance(to other: Point) -> Double {
		return sqrt((x - other.x) * (x - other.x) + (y - other.y) * (y - other.y))
	}

	var magnitude: Double {
		return sqrt(x * x + y * y)
	}
}

protocol Drawable {
	func draw()
	var area: Double { get }
}

enum Direction {
	case north
	case south
	case east
	case west
}

class Counter {
	var count: Int = 0
	static let max: Int = 100

	func increment() {
		count += 1
	}
}

func topLevel() -> Int {
	return 42
}

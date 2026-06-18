// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IGreeter {
	function greet() external view returns (string memory);
}

library Math {
	function add(uint256 a, uint256 b) internal pure returns (uint256) {
		return a + b;
	}
}

struct Point {
	uint256 x;
	uint256 y;
}

enum Color {
	Red,
	Green
}

contract Greeter is IGreeter {
	string public name;
	uint256 public constant VERSION = 1;

	modifier onlyOwner() {
		_;
	}

	constructor(string memory _name) {
		name = _name;
	}

	function greet() external view override returns (string memory) {
		return name;
	}

	event Greeted(address indexed caller);
}

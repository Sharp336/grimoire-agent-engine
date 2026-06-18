#!/usr/bin/env bash

readonly VERSION="1.0"

top_level() {
	echo "top"
}

function named {
	local x=1
	echo "$x"
}

outer() {
	inner() {
		echo "nested"
	}
	inner
}

top_level

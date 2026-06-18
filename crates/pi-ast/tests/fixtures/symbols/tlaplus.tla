---- MODULE Counter ----
EXTENDS Naturals, Integers

CONSTANTS MaxCount

VARIABLES counter

Init == counter = 0

Increment == counter' = counter + 1

Next == Increment

Spec == Init /\ [][Next]_counter

MaxVal == MaxCount
====

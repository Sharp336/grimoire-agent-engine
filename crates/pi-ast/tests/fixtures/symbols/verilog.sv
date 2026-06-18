// SystemVerilog fixture: modules, functions, tasks, ports/nets.

module Adder (
    input  wire [7:0] a,
    input  wire [7:0] b,
    output wire [7:0] sum
);
    logic carry;

    assign sum = a + b;

    function automatic [7:0] double(input [7:0] x);
        begin
            double = x << 1;
        end
    endfunction

    task automatic clear(input [7:0] unused);
        begin
            carry = 1'b0;
        end
    endtask
endmodule

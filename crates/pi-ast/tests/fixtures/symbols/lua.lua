local function greet(name)
    return "Hi " .. name
end

local M = {}

function M.helper()
    return 1
end

function M.shout(msg)
    print(msg)
end

M.count = 0

function topLevel()
    return 1
end

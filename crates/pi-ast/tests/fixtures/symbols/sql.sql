-- SQL DDL fixture: tables, views, and functions with columns.

CREATE TABLE users (
    id    INTEGER PRIMARY KEY,
    name  TEXT NOT NULL,
    email TEXT UNIQUE
);

CREATE VIEW active_users AS
SELECT id, name FROM users WHERE id > 0;

CREATE FUNCTION add(a INTEGER, b INTEGER)
RETURNS INTEGER
LANGUAGE SQL
AS 'SELECT a + b';

CREATE FUNCTION greet(who TEXT)
RETURNS TEXT
LANGUAGE SQL
AS 'SELECT who';

(defconst pi 3.14159)

(defvar counter 0)

(defmacro with-log (body)
  `(progn (message "enter") ,body))

(defstruct employee name role)

(defun add (a b)
  (+ a b))

(defclass my-class ()
  ((slot1 :initarg :slot1)))

;; A lambda and a regular call should not be emitted as symbols.
(lambda (x) (* x x))
(some-call 1 2 3)

(ns myapp.core
  (:require [clojure.string :as str]))

(def MAX-SIZE 100)

(defn greet
  "Greets a person."
  [name]
  (println "Hello," name))

(defn- helper [x]
  (* x 2))

(defmacro unless [condition body]
  `(when (not ~condition) ~body))

(defrecord Person [name age])

(deftype Point [x y])

(defprotocol Drawable
  (draw [this])
  (bounds [this]))

;; A bare call must not be emitted as a symbol.
(println "done")

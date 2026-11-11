# Smell baseline (Standards axis)

A fixed set of Fowler code smells (_Refactoring_, ch. 3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. Skip anything tooling already enforces.

Each smell reads _what it is_ → _how to fix_; match it against the diff:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same conditional over the same discriminator in several places. → polymorphism or a lookup table keyed by the discriminator.
- **Long Parameter List**: a function taking so many arguments that callers struggle to order them. → pass an options object or derive values inside.
- **Global Data**: mutable state reachable from anywhere. → encapsulate behind a function that owns the mutation.
- **Mutable Data**: a value changed in several places so reasoning about its state is hard. → return new values; split read from write.
- **Divergent Change**: one module edited for unrelated reasons. → split the module along the reasons it changes.
- **Shotgun Surgery**: one change touching many modules. → move the scattered pieces together.
- **Long Function**: a function doing several things, needing comments to read. → extract until each piece names itself.
- **Lazy Element**: a function or class that doesn't earn its existence. → inline it.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

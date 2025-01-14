# Option A
## Hack together a faux-cryptonote walahash pool using existing infrastructure
### Pros
- Can start work on the protocol right away
- Doesn't require much engineering work

### Cons
- Every step of the implementation takes much longer due to the "shoehorning" nature
- Won't be clean
- Hard to maintain

# Option B ("proper" way)
## Setup a new pathway in this pool codebase + config skeleton explicitly for non-cryptonote algos
### Pros
- Easy to understand and maintain once done
- Allows for tailor-made features + flow
- Bugs less likely + easier to fix

### Cons
- Requires true engineering work up-front
- Turnaround time likely longer
- Despite the objective pros, the scope creates a ton of unnecessary development overhead, given the objective is simply to have a walahash pool
from itertools import permutations
elements = ['2', '0', '1', '9', '20', '19']
s = set()
for p in permutations(elements):
    if p[0] != '0':
        s.add(''.join(p))
print(len(s))
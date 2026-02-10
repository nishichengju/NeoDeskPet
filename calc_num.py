from itertools import permutations
blocks = ['2', '0', '1', '9', '20', '19']
results = set()
for p in permutations(range(6)):
    s = ''.join(blocks[i] for i in p)
    if s[0] != '0':
        results.add(s)
print(len(results))
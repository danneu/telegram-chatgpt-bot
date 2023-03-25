import sys
import tiktoken

if len(sys.argv) != 2:
    print('Must provide one input argument')
    sys.exit()

input = sys.argv[-1]

enc = tiktoken.encoding_for_model('gpt-3.5-turbo')
count = len(enc.encode(input))

print(count) # "8\n"

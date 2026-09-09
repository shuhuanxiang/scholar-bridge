# Method

我们提出 **FedContra**,一种新的联邦学习防御方法。

The objective is $L = L_1 + \lambda L_2$ where $\lambda$ controls the
contrastive strength.

1. Train the adapter.
2. Audit the model.

- robustness
  - word-level diff
- safety

> 该方法显著提高模型的鲁棒性。

`model.eval()` runs in evaluation mode.

```python
model.eval()
```

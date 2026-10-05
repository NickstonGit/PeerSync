import os
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))


class NamedPipeSecuritySourceTests(unittest.TestCase):
    def test_named_pipe_uses_private_explicit_dacl(self):
        path = os.path.join(ROOT, "windows", "pipes.py")
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("ConvertStringSecurityDescriptorToSecurityDescriptorW", src)
        self.assertIn("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;OW)", src)
        self.assertIn("ctypes.byref(security)", src)
        self.assertNotIn("0,\n                    None,\n                ),\n                \"CreateNamedPipeW\"", src)

    def test_named_pipe_connect_errors_fail_closed(self):
        path = os.path.join(ROOT, "windows", "pipes.py")
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("if error == ERROR_PIPE_CONNECTED:", src)
        self.assertIn("elif error == ERROR_OPERATION_ABORTED and self._stop.is_set():", src)
        self.assertIn('raise ctypes.WinError(error, f"ConnectNamedPipe({self.name})")', src)



if __name__ == "__main__":
    unittest.main()

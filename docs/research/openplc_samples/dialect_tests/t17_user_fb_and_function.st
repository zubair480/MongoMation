FUNCTION add3 : INT
  VAR_INPUT a : INT; b : INT; c : INT; END_VAR
  add3 := a + b + c;
END_FUNCTION

FUNCTION_BLOCK Latch
  VAR_INPUT set : BOOL; rst : BOOL; END_VAR
  VAR_OUTPUT q : BOOL; END_VAR
  IF rst THEN q := FALSE; ELSIF set THEN q := TRUE; END_IF;
END_FUNCTION_BLOCK

PROGRAM main
  VAR
    l1 : Latch; s : BOOL; r : BOOL; out : BOOL; i : INT;
  END_VAR
  l1(set := s, rst := r);
  out := l1.q;
  i := add3(1, 2, 3);
  i := add3(a := 1, b := 2, c := 3);
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms,PRIORITY := 0);
    PROGRAM instance0 WITH task0 : main;
  END_RESOURCE
END_CONFIGURATION

PROGRAM main
  VAR
    arr : ARRAY[0..9] OF INT; k : INT; state : INT; s : STRING := 'hello'; n : INT; done : BOOL;
  END_VAR
  FOR k := 0 TO 9 BY 1 DO arr[k] := k * 2; END_FOR;
  WHILE n < 5 DO n := n + 1; END_WHILE;
  REPEAT n := n - 1; UNTIL n <= 0 END_REPEAT;
  CASE state OF
    0: state := 1;
    1, 2: state := 3;
    3..5: done := TRUE; state := 0;
  ELSE state := 0;
  END_CASE;
  s := CONCAT(s, ' world');
  n := LEN(s);
END_PROGRAM

CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms,PRIORITY := 0);
    PROGRAM instance0 WITH task0 : main;
  END_RESOURCE
END_CONFIGURATION

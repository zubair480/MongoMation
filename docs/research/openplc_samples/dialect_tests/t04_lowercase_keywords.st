program main
  var
    a : bool;
    t1 : ton;
  end_var
  t1(in := not a, pt := t#1s);
  if t1.q then a := true; elsif a then a := false; end_if;
end_program

configuration config0
  resource res0 on plc
    task task0(interval := t#20ms, priority := 0);
    program instance0 with task0 : main;
  end_resource
end_configuration
